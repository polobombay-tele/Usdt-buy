# Real BEP-20 USDT wallet starter

This project performs REAL ERC-20 transfers when configured with a real BSC RPC, token contract and a dedicated server-side wallet.

## Flow
1. User registers.
2. Server derives a unique BSC deposit address from a dedicated HD wallet.
3. User sends the supported token to that address.
4. Scanner watches `Transfer` events and credits the user's internal balance after confirmations.
5. Withdrawal sends tokens from the treasury wallet to the user's requested BEP-20 address.
6. BNB must be available for gas.

## IMPORTANT before mainnet
- Do NOT use a personal wallet seed.
- Do NOT commit `.env`.
- Use a dedicated hot wallet with a small operating balance.
- Replace starter password hashing with Argon2id/bcrypt and real session authentication.
- Use PostgreSQL instead of SQLite for a multi-instance production deployment.
- Add withdrawal rate limits, 2FA/admin approval, address allowlisting, audit logs, nonce management, reconciliation and monitoring.
- Confirm the exact token contract you intend to support. Do not label an unverified/incorrect contract as Tether USDT.
- Test on BSC Testnet first.
- For mainnet, set chain ID 56 and use the verified contract address for the exact asset/network you intend to support.

The BSC docs list mainnet Chain ID 56 and testnet Chain ID 97. BSC uses BNB for native gas.

## Render
Create a Web Service from this project.
- Build: `npm install`
- Start: `npm start`
- Add environment variables from `.env.example`.
- For production, move the database from SQLite to PostgreSQL before scaling.
- Keep the wallet seed only in the server environment/secret manager.

## Mainnet switch
Use `BSC_CHAIN_ID=56` and a reliable BSC mainnet RPC.
Do not hard-code an unverified token contract. Confirm the exact supported USD₮/USDT contract for the network before enabling deposits.
