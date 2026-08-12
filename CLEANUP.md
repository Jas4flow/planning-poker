# Planning Poker Cleanup Service

Automated background cleanup that deletes completed planning poker rooms older than 30 days.

## What Gets Deleted

✓ **Deleted:**
- Rooms (`pp_rooms`) not updated in 30+ days
- Associated room members (`pp_room_members`) via cascade delete

✗ **NOT Deleted:**
- User profiles (`pp_profiles`)
- User authentication data
- Jira settings (`pp_jira_settings`)

## Setup

### 1. Install Dependencies

```bash
npm install @supabase/supabase-js dotenv
```

Or add to your `package.json`:
```json
{
  "dependencies": {
    "@supabase/supabase-js": "^2.x.x"
  }
}
```

### 2. Configure Environment Variables

Create a `.env` file or set environment variables:

```bash
# Required
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your_service_role_key_here

# Optional
CLEANUP_INTERVAL=86400000  # 24 hours in milliseconds (default)
DAYS_TO_KEEP=30            # Days before deletion (default)
```

**Getting your Supabase credentials:**
1. Go to Supabase Dashboard → Settings → API
2. Copy your **Project URL**
3. Copy your **Service Role** key (not the anon key)
4. Never commit these to git — use `.env` and add to `.gitignore`

### 3. (Optional) Run Database Migration

To enable server-side cleanup functions in Supabase:

1. Go to Supabase Dashboard → SQL Editor
2. Create a new query
3. Copy and paste contents of `db/cleanup-migration.sql`
4. Click **Run**

This creates the `pp_cleanup_old_rooms()` function that can be called manually or from Node.js.

## Running the Cleanup Service

### Background Process (Recommended)

```bash
node cleanup.mjs
```

Or with custom settings:

```bash
DAYS_TO_KEEP=60 CLEANUP_INTERVAL=43200000 node cleanup.mjs
```

The service will:
- Run immediately on startup
- Run again every 24 hours (configurable)
- Log deleted rooms with timestamps
- Handle errors gracefully
- Respond to SIGINT/SIGTERM for clean shutdown

### One-Time Cleanup

If you have the database migration installed, run:

```bash
node -e "
import { createClient } from '@supabase/supabase-js';
const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const {data, error} = await client.rpc('pp_cleanup_old_rooms', {days_to_keep: 30});
console.log(error ? 'Error: ' + error.message : 'Deleted: ' + data.deleted_count);
"
```

## Running as a System Service

### On Linux/macOS (systemd)

Create `/etc/systemd/system/pp-cleanup.service`:

```ini
[Unit]
Description=Planning Poker Cleanup Service
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/path/to/planing-poker
Environment="SUPABASE_URL=https://..."
Environment="SUPABASE_SERVICE_KEY=..."
ExecStart=/usr/bin/node /path/to/cleanup.mjs
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Then enable:
```bash
sudo systemctl enable pp-cleanup
sudo systemctl start pp-cleanup
sudo systemctl status pp-cleanup
```

### On Windows (Node Process Manager)

Install PM2:
```bash
npm install -g pm2
```

Create `ecosystem.config.js`:
```javascript
module.exports = {
  apps: [{
    name: 'pp-cleanup',
    script: './cleanup.mjs',
    instances: 1,
    exec_mode: 'fork',
    env: {
      SUPABASE_URL: 'https://your-project.supabase.co',
      SUPABASE_SERVICE_KEY: 'your-key-here',
      CLEANUP_INTERVAL: '86400000',
      DAYS_TO_KEEP: '30'
    }
  }]
};
```

Then run:
```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

## Monitoring & Logs

The cleanup service logs:
- Startup configuration
- Database statistics (total rooms, rooms eligible for deletion)
- Each cleanup run with timestamp
- Deleted rooms with their IDs
- Any errors encountered

Example output:
```
Planning Poker Cleanup Service
Interval: 24 hour(s)
Retention: 30 days
Starting...

[2026-08-12T10:30:45.123Z] Starting cleanup of rooms not updated since Mon Aug 13...
✓ Deleted 3 old room(s):
  - room-123 (Sprint Planning)
  - room-456 (Refinement)
  - room-789 (Backlog Review)

Database stats:
  Total rooms: 45
  Rooms eligible for deletion: 0
```

## Customization

### Adjust Retention Period

Keep rooms for 60 days instead of 30:
```bash
DAYS_TO_KEEP=60 node cleanup.mjs
```

### Adjust Cleanup Frequency

Run cleanup every 12 hours instead of 24:
```bash
CLEANUP_INTERVAL=43200000 node cleanup.mjs
```

### Add Selective Deletion

Edit `cleanup.mjs` to only delete rooms marked as "completed":

```javascript
// In cleanupOldRooms(), modify the query:
const { data, error, count } = await supabase
  .from("pp_rooms")
  .delete()
  .lt("updated_at", thirtyDaysAgo.toISOString())
  .eq("state->>status", "completed")  // Only completed rooms
  .select("id, name");
```

## Troubleshooting

**Error: "Set SUPABASE_URL and SUPABASE_SERVICE_KEY"**
- Verify `.env` file exists and contains both variables
- Check they're not wrapped in quotes: `SUPABASE_URL=https://...` not `SUPABASE_URL="https://..."`

**Error: "Row level security" or "permission denied"**
- Use the **Service Role** key, not the anon key
- Service role has unrestricted database access

**No rooms deleted?**
- Check database stats in the logs
- Manually verify old rooms exist: check Supabase Dashboard
- Adjust `DAYS_TO_KEEP` to a smaller value for testing

**Rooms aren't being deleted but no error shows**
- Increase verbosity by checking the database directly
- Run the SQL query manually in Supabase SQL Editor:
  ```sql
  select count(*) from pp_rooms where updated_at < now() - interval '30 days';
  ```

## Security Notes

- The cleanup service uses the **Service Role** key which bypasses RLS policies
- Never commit `.env` to version control
- Rotate your Supabase keys regularly
- Consider running the service on a private network or VPN-protected machine
- Logs may contain room IDs — audit them for sensitive data

## FAQ

**Q: Will this delete active rooms?**
A: No. Only rooms not updated for 30+ days are deleted (configurable).

**Q: Can I recover deleted rooms?**
A: If your Supabase plan includes backups, contact Supabase support. Always test with a longer retention period first.

**Q: What about rooms in progress?**
A: Rooms are only deleted if `updated_at` hasn't changed in 30 days. Active rooms are continuously updated and never deleted.

**Q: Can I run this on Supabase Cloud Functions instead?**
A: Yes! Use Supabase Edge Functions to call the cleanup function on a schedule. See Supabase docs for cron trigger setup.

**Q: Does this affect real-time subscriptions?**
A: No. Existing connections to deleted rooms will lose sync, which is expected behavior for old inactive sessions.
