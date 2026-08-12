# Supabase Jira Proxy Setup

## Free CORS Proxy using Supabase Edge Functions

This Supabase Edge Function acts as a CORS proxy for Jira, allowing your GitHub-deployed Planning Poker app to communicate with Jira Cloud.

**Why Supabase?**
- ✅ **FREE** - Included with Supabase free tier
- ✅ **No extra deployment** - Already part of your infrastructure
- ✅ **Public URL** - Accessible from browser and GitHub Pages
- ✅ **Auto-deploy** - Deploy with `git push`

## Setup Steps

### 1. Install Supabase CLI (if not already installed)

```bash
# macOS/Linux
brew install supabase/tap/supabase

# Windows (with choco)
choco install supabase

# Or npm
npm install -g supabase
```

### 2. Link Your Project to Supabase

```bash
cd "c:\Users\m.jassim\OneDrive - 4flow SE\Desktop\Planing Poker online"
supabase login
supabase link --project-ref your-project-ref
```

Get your project ref from: https://app.supabase.com → Settings → General → Project Ref

### 3. Deploy the Edge Function

```bash
supabase functions deploy jira-proxy
```

You should see:
```
✓ Function jira-proxy deployed
Endpoint: https://your-project.supabase.co/functions/v1/jira-proxy
```

### 4. Copy Your Function URL

From Supabase Dashboard:
1. Go to **Edge Functions** (in left sidebar)
2. Click **jira-proxy**
3. Copy the full URL

### 5. Configure in Planning Poker App

1. Open the app (localhost or GitHub Pages)
2. Click **Jira settings**
3. Enter your Jira credentials:
   - **Jira base URL:** `https://your-company.atlassian.net`
   - **Email:** Your Atlassian email
   - **API token:** [Get here](https://id.atlassian.com/manage-profile/security/api-tokens)

4. **Proxy URL:** Paste your Edge Function URL:
   ```
   https://your-project.supabase.co/functions/v1/jira-proxy/
   ```
   (Make sure it ends with `/`)

5. Click **Test connection** ✓

## How It Works

```
Browser (GitHub Pages)
    ↓ https://your-project.supabase.co/functions/v1/jira-proxy
Supabase Edge Function
    ↓ (adds CORS headers)
Jira Cloud API
    ↓ (response with CORS headers)
Browser receives data ✓
```

## Troubleshooting

### "Failed to fetch"
- Check proxy URL ends with `/`
- Test your Jira credentials first

### "403 Forbidden"
- Your Jira account lacks permissions
- Ask admin to grant access to CUMA project

### Function not found
- Run `supabase functions deploy jira-proxy` again
- Check project ref is correct

### Still seeing CORS errors
- Clear browser cache (Ctrl+Shift+Delete)
- Try in an incognito window
- Check proxy URL in browser console (F12)

## Environment Variables (Optional)

If you want to restrict which Jira hosts the proxy can access:

1. In Supabase Dashboard → Edge Functions → jira-proxy
2. Add secrets:
   ```
   ALLOWED_JIRA_HOSTS=your-company.atlassian.net
   ```

## Auto-Deploy on Git Push

Once you push this folder to GitHub, Supabase automatically deploys:

```bash
git add supabase/functions/jira-proxy/
git commit -m "Add Supabase Jira proxy Edge Function"
git push
```

## Cost

✅ **Completely FREE** on Supabase free tier
- 144,000 invocations/month included
- ~5,000 per day should be plenty
- No credit card required

## Alternative: For Self-Hosted Jira

If using Jira Server/Data Center (not Cloud):

1. Make sure your firewall allows outbound HTTPS to Supabase
2. Or deploy proxy locally and whitelist your IP

## Support

- [Supabase Edge Functions Docs](https://supabase.com/docs/guides/functions)
- [Planning Poker CODEBASE.md](../CODEBASE.md) for app architecture
