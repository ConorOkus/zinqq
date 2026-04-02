# Mainnet Rollback Procedure

What to do if the mainnet deployment (`zinqq.app`) hits a critical bug after users have open channels.

## Severity Levels

### Level 1: UI bug, no fund risk

- Fix and redeploy. No special procedure needed.

### Level 2: Payments broken, funds safe

- Deploy a fix or revert the last deployment.
- Channels remain open and safe; users just can't send/receive until fixed.

### Level 3: Fund safety risk (force-close bug, persistence failure, etc.)

- Follow the full procedure below.

## Full Rollback Procedure

### 1. Display maintenance banner

Add a `VITE_MAINTENANCE_MODE=true` env var to the mainnet Vercel project. The app should check this at startup and display a read-only warning banner. Users can still view balances but sends are disabled.

```bash
npx vercel env add VITE_MAINTENANCE_MODE production <<< "true"
npx vercel --project zinqq-app-mainnet --prod
```

### 2. Disable new channel opens

Set the LSP env vars to empty on the mainnet Vercel project. This prevents new JIT channels while keeping existing channels operational.

```bash
npx vercel env rm VITE_LSP_NODE_ID production
npx vercel env rm VITE_LSP_HOST production
npx vercel --project zinqq-app-mainnet --prod
```

### 3. Assess the bug

- Check browser console logs from affected users
- Review error monitoring (Sentry) for the specific failure
- Determine if channels are at risk or if the issue is isolated

### 4. If channels are at risk: cooperative close

If the bug affects channel state or persistence, guide users to cooperatively close channels before they force-close:

1. Deploy a hotfix that surfaces a "Close Channel" button prominently
2. Communicate via available channels (Twitter, website banner) that users should close channels
3. Cooperative close returns funds to the BDK on-chain wallet immediately

### 5. If cooperative close is not possible: force-close

If the counterparty is unresponsive or the bug prevents cooperative close:

1. Force-close broadcasts the commitment transaction
2. The CPFP handler will fee-bump if needed (requires on-chain balance)
3. Funds return after the timelock expires (typically 144 blocks / ~1 day)

### 6. Deploy fix and restore

1. Fix the bug on a feature branch
2. Test on signet (`testnet.zinqq.app`)
3. Deploy to mainnet
4. Remove `VITE_MAINTENANCE_MODE` env var
5. Restore LSP configuration

```bash
npx vercel env rm VITE_MAINTENANCE_MODE production
npx vercel --project zinqq-app-mainnet --prod
```

## Communication

- Display in-app banner explaining the situation and expected resolution time
- Post update on project social channels if the outage exceeds 1 hour
- For fund-risk scenarios, provide clear instructions for users to secure funds
