# Todo App

A Next.js todo app powered by InsForge with Google OAuth. Uses the InsForge SDK directly for auth (no provider package).

## Setup

1. Install dependencies (already done):
   ```bash
   npm install
   ```

2. Environment variables are in `.env.local`:
   - `NEXT_PUBLIC_INSFORGE_BASE_URL` – InsForge backend URL
   - `NEXT_PUBLIC_INSFORGE_ANON_KEY` – Anonymous key for client access

## Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Features

- **Google OAuth** – Sign in with your Google account
- **Add todos** – Create new todo items
- **Toggle completion** – Mark todos as done/undone
- **Delete todos** – Remove todos you no longer need
- **User-scoped data** – Todos are stored per user in InsForge PostgreSQL (`todos` table with RLS)
