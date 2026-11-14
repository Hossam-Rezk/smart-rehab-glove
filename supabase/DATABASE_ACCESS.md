# Database access (Supabase)

| | |
|---|---|
| Project name | `smart-rehab-glove` |
| Project URL | https://zbofolbkacqclmpkjtbk.supabase.co |
| Project ref | `zbofolbkacqclmpkjtbk` |
| Region | eu-central-1 (Frankfurt) |
| Database host | `db.zbofolbkacqclmpkjtbk.supabase.co` |
| Database port | `5432` |
| Database name | `postgres` |
| Database user | `postgres` |
| Database password | `SmartGloves110` |

Direct connection string:

```
postgresql://postgres:SmartGloves110@db.zbofolbkacqclmpkjtbk.supabase.co:5432/postgres
```

The website itself does **not** need the password. It uses the public anon key
in `web/config.js`, and the database rules (Row Level Security) let everyone:

- read the tutorials,
- read and add patients,
- read and add sessions, repetitions and thumb-touch trials.

> Warning: the password above gives full admin access to the database (it can
> change or delete everything). Anyone who can see this repository can use it.
> If the repository is made public, change the password in the Supabase
> dashboard (Project Settings > Database > Reset database password).

Tables: `patients`, `tutorials`, `sessions`, `repetitions`, `touch_trials`
(see `schema.sql`).
