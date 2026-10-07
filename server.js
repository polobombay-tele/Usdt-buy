import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import Database from "better-sqlite3";
import QRCode from "qrcode";
import { ethers } from "ethers";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const app=express();
app.use(helmet({contentSecurityPolicy:false}));
app.use(cors());
app.use(express.json({limit:"32kb"}));
app.use(express.static(path.join(__dirname,"public")));

const cfg={
  rpc:process.env.BSC_RPC_URL,
  chainId:Number(process.env.BSC_CHAIN_ID||97),
  explorer:process.env.BSC_EXPLORER||"https://testnet.bscscan.com",
  token:(process.env.USDT_CONTRACT||"").toLowerCase(),
  decimals:Number(process.env.USDT_DECIMALS||18),
  minDeposit:Number(process.env.MIN_DEPOSIT_USDT||0.1),
  minWithdraw:Number(process.env.MIN_WITHDRAW_USDT||0.1),
  fee:Number(process.env.WITHDRAW_FEE_USDT||0),
  confirmations:Number(process.env.CONFIRMATIONS||12),
  adminToken:process.env.ADMIN_TOKEN||""
};
if(!cfg.rpc) throw new Error("BSC_RPC_URL missing");
if(!process.env.WALLET_MNEMONIC) throw new Error("WALLET_MNEMONIC missing");

const provider=new ethers.JsonRpcProvider(cfg.rpc, cfg.chainId);
const master=ethers.HDNodeWallet.fromPhrase(process.env.WALLET_MNEMONIC, undefined, "m/44'/60'/0'/0");
const treasury=master.deriveChild(0).connect(provider);

const db=new Database(process.env.DB_FILE||"wallet.db");
db.pragma("journal_mode=WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS users(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 username TEXT UNIQUE NOT NULL,
 password_hash TEXT NOT NULL,
 derivation_index INTEGER UNIQUE NOT NULL,
 address TEXT UNIQUE NOT NULL,
 balance TEXT NOT NULL DEFAULT '0',
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deposits(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL,
 tx_hash TEXT UNIQUE NOT NULL,
 amount TEXT NOT NULL,
 block_number INTEGER NOT NULL,
 confirmations INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS withdrawals(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL,
 to_address TEXT NOT NULL,
 amount TEXT NOT NULL,
 fee TEXT NOT NULL,
 tx_hash TEXT,
 status TEXT NOT NULL,
 created_at TEXT NOT NULL
);
`);

const ERC20_ABI=[
 "function balanceOf(address) view returns (uint256)",
 "function transfer(address to,uint256 amount) returns (bool)",
 "function decimals() view returns (uint8)",
 "event Transfer(address indexed from,address indexed to,uint256 value)"
];
const token=new ethers.Contract(cfg.token,ERC20_ABI,provider);

function now(){return new Date().toISOString();}
function units(v){return ethers.parseUnits(String(v),cfg.decimals);}
function format(v){return Number(ethers.formatUnits(v,cfg.decimals)).toFixed(6);}
function auth(req,res,next){
  if(req.headers.authorization!==`Bearer ${cfg.adminToken}`) return res.status(401).json({error:"Unauthorized"});
  next();
}
function getUser(id){return db.prepare("SELECT * FROM users WHERE id=?").get(id);}

function walletForIndex(i){
  return master.deriveChild(i).connect(provider);
}

/* Demo registration endpoint. Password hashing is intentionally left out of this starter:
   use Argon2/bcrypt + real sessions/JWT before exposing registration publicly. */
app.post("/api/register",async(req,res)=>{
  try{
    const {username,password}=req.body||{};
    if(!username||!password||password.length<12) return res.status(400).json({error:"Username and password (12+ chars) required"});
    const next=(db.prepare("SELECT COALESCE(MAX(derivation_index),0)+1 n FROM users").get().n)||1;
    const w=walletForIndex(next);
    // For this starter, the password is NOT stored as plaintext; replace this line with Argon2/bcrypt.
    const password_hash=ethers.keccak256(ethers.toUtf8Bytes(password+"|starter-only"));
    const info=db.prepare("INSERT INTO users(username,password_hash,derivation_index,address,balance,created_at) VALUES(?,?,?,?,?,?)")
      .run(username,password_hash,next,w.address,"0",now());
    res.json({userId:info.lastInsertRowid,address:w.address,message:"Account created. This endpoint must use real password hashing before production."});
  }catch(e){res.status(400).json({error:String(e.message||e)})}
});

app.get("/api/config",(req,res)=>res.json({
  chainId:cfg.chainId,network:cfg.chainId===56?"BSC Mainnet":"BSC Testnet",
  token:cfg.token,minDeposit:cfg.minDeposit,minWithdraw:cfg.minWithdraw,withdrawFee:cfg.fee,
  explorer:cfg.explorer
}));

app.get("/api/deposit/:userId",async(req,res)=>{
  const u=getUser(req.params.userId);
  if(!u)return res.status(404).json({error:"User not found"});
  const qr=await QRCode.toDataURL(u.address,{margin:1,width:260});
  res.json({address:u.address,qr});
});

app.get("/api/balance/:userId",async(req,res)=>{
  const u=getUser(req.params.userId);
  if(!u)return res.status(404).json({error:"User not found"});
  res.json({creditedBalance:u.balance,address:u.address});
});

app.get("/api/transactions/:userId",(req,res)=>{
  const u=getUser(req.params.userId);
  if(!u)return res.status(404).json({error:"User not found"});
  const deposits=db.prepare("SELECT 'deposit' type,amount,status,tx_hash txHash,created_at createdAt FROM deposits WHERE user_id=? ORDER BY id DESC").all(u.id);
  const withdrawals=db.prepare("SELECT 'withdrawal' type,amount,status,tx_hash txHash,created_at createdAt FROM withdrawals WHERE user_id=? ORDER BY id DESC").all(u.id);
  res.json([...deposits,...withdrawals].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)));
});

app.post("/api/withdraw",async(req,res)=>{
  try{
    const {userId,to,amount}=req.body||{};
    const u=getUser(userId);
    if(!u)return res.status(404).json({error:"User not found"});
    if(!ethers.isAddress(to))return res.status(400).json({error:"Invalid BEP-20 address"});
    const n=Number(amount);
    if(!Number.isFinite(n)||n<cfg.minWithdraw)return res.status(400).json({error:`Minimum withdrawal is ${cfg.minWithdraw} USDT`});
    if(n>Number(u.balance))return res.status(400).json({error:"Insufficient balance"});
    if(n+cfg.fee>Number(u.balance))return res.status(400).json({error:"Insufficient balance including fee"});
    const value=units(n);
    // Real mainnet/testnet transaction. treasury must hold enough token and BNB for gas.
    const signer=treasury;
    const c=token.connect(signer);
    const tx=await c.transfer(to,value);
    db.prepare("INSERT INTO withdrawals(user_id,to_address,amount,fee,tx_hash,status,created_at) VALUES(?,?,?,?,?,?,?)")
      .run(u.id,to,String(n),String(cfg.fee),tx.hash,"submitted",now());
    const newBal=(Number(u.balance)-n-cfg.fee).toFixed(6);
    db.prepare("UPDATE users SET balance=? WHERE id=?").run(newBal,u.id);
    res.json({status:"submitted",txHash:tx.hash,explorer:`${cfg.explorer}/tx/${tx.hash}`});
  }catch(e){res.status(500).json({error:String(e.shortMessage||e.message||e)})}
});

/* Deposit scanner:
   Each user's derived address is watched for ERC-20 Transfer events.
   It credits only transfers >= minimum and only after configured confirmations.
*/
async function scanDeposits(){
  if(!cfg.token || cfg.token==="0x0000000000000000000000000000000000000000") return;
  const latest=await provider.getBlockNumber();
  const users=db.prepare("SELECT * FROM users").all();
  for(const u of users){
    const fromBlock=Math.max(0,latest-5000);
    const filter=token.filters.Transfer(null,u.address);
    const logs=await token.queryFilter(filter,fromBlock,latest);
    for(const log of logs){
      const txHash=log.transactionHash;
      if(db.prepare("SELECT 1 FROM deposits WHERE tx_hash=?").get(txHash)) continue;
      const amount=format(log.args.value);
      if(Number(amount)<cfg.minDeposit) continue;
      const block=log.blockNumber;
      const confirmations=Math.max(0,latest-block+1);
      const status=confirmations>=cfg.confirmations?"confirmed":"confirming";
      db.prepare("INSERT INTO deposits(user_id,tx_hash,amount,block_number,confirmations,status,created_at) VALUES(?,?,?,?,?,?,?)")
        .run(u.id,txHash,amount,block,confirmations,status,now());
      if(status==="confirmed"){
        const bal=Number(u.balance)+Number(amount);
        db.prepare("UPDATE users SET balance=? WHERE id=?").run(bal.toFixed(6),u.id);
      }
    }
  }
}
setInterval(()=>scanDeposits().catch(console.error),15000);

app.get("/api/admin/users",auth,(req,res)=>{
  res.json(db.prepare("SELECT id,username,address,balance,created_at createdAt FROM users ORDER BY id DESC").all());
});
app.get("/api/admin/treasury",auth,async(req,res)=>{
  const native=await provider.getBalance(treasury.address);
  let usdt="0";
  if(cfg.token && cfg.token!=="0x0000000000000000000000000000000000000000") usdt=format(await token.balanceOf(treasury.address));
  res.json({address:treasury.address,bnb:ethers.formatEther(native),usdt});
});

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.listen(Number(process.env.PORT||3000),()=>console.log(`Wallet server on ${process.env.PORT||3000}`));
