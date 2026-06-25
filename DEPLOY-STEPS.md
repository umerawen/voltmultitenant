# 🚀 Putting VOLT League online — super simple steps

We have THREE helpers:
- **GitHub** = the locker where your code lives
- **Vercel** = turns the code into a real website (free)
- **Supabase** = the brain that remembers all accounts & data (free)

You'll do them in this order: Supabase first (get the keys), then GitHub
(upload code), then Vercel (go live). Take it slow. Each step is small.

---

## 🧠 PART 1 — Make the brain (Supabase)

1. Go to **supabase.com** and sign in (or sign up — it's free).
2. Click **New Project**. Give it a name like `volt-league`. Pick any
   password it asks for and **save that password somewhere**. Click create.
   Wait ~1 minute for it to finish setting up.
3. On the left menu, click **SQL Editor**.
4. Open the file **`schema.sql`** (it's inside your download). Copy
   **ALL** of it. Paste it into the big box in Supabase. Click **Run**
   (bottom right). You should see "Success". 🎉 The brain now has all its
   tables.
5. Now we grab two secret keys. On the left, click the **gear / Settings**,
   then **API**.
6. Copy these two things into a notepad — you'll need them in Part 3:
   - **Project URL** (looks like `https://abcd.supabase.co`)
   - **anon public** key (a long string of letters)
7. Also on the left, click **Authentication → Providers** and make sure
   **Email** is turned ON. (It usually already is.)

✅ Brain done.

---

## 📦 PART 2 — Put the code on GitHub

You already know GitHub, so this is easy.

1. Unzip the **`volt-league.zip`** file on your computer. You'll get a
   folder called `volt-league`.
2. Go to **github.com**, click **New repository**.
3. Name it `volt-league`. Leave it **empty** (don't add a README — ours is
   already inside). Click **Create repository**.
4. GitHub shows you a page with commands OR an **"uploading an existing
   file"** link. Easiest way: click **"uploading an existing file"**, then
   **drag the WHOLE contents of the `volt-league` folder** into the box.
   (Drag the files inside the folder, not the folder itself.)
5. Scroll down, click **Commit changes**.

✅ Code is on GitHub.

> ⚠️ Note: there's a file called `.env.example` — that's fine to upload.
> There is NO `.env` file with secrets in the zip, so nothing private gets
> uploaded. Good.

---

## 🌐 PART 3 — Go live (Vercel)

1. Go to **vercel.com** and sign in (you can sign in **with GitHub** — one
   click).
2. Click **Add New… → Project**.
3. Find your **`volt-league`** repo in the list and click **Import**.
4. Vercel will auto-detect it's a Vite app — you don't change anything.
5. **IMPORTANT:** before you click Deploy, open **Environment Variables**
   and add the two keys from Part 1:
   - Name: `VITE_SUPABASE_URL`  → Value: your Project URL
   - Name: `VITE_SUPABASE_ANON_KEY` → Value: your anon public key
   Add each one, then…
6. Click **Deploy**. Wait ~1 minute.
7. 🎉 Vercel gives you a live link like `volt-league.vercel.app`. Open it!

You should see the **VOLT League** sign-in screen.

---

## ✅ PART 4 — Test it works

1. On your live site, click **Create account**, use any email + password.
   (If Supabase asks you to confirm by email, check your inbox, click the
   link, then come back and sign in.)
2. After signing in, pick **"Start a league"**, type a community name and
   your display name, and create it.
3. You'll land on the Home screen showing your community + a **join code**.
4. Open the site on your phone (or another browser), make a second account,
   pick **"Join as player"**, type that join code → you're in as a player.

If both worked, your separate SaaS app is LIVE and totally apart from the
old VOLT draft. 🟢

---

## 🟡 One thing to know

When you create a community, it starts as **"pending"** (not paying yet).
That's on purpose — later, payments will flip it to "active" automatically.
For now everything still works for testing. To mark a community active
yourself: Supabase → **Table Editor → communities →** change
`subscription_status` to `active`.

---

## 😅 If something looks broken

- **"database isn't connected yet" screen** → the two Vercel environment
  variables are missing or misspelled. Fix them in Vercel → Settings →
  Environment Variables, then **Redeploy**.
- **Sign-in does nothing** → check the email got confirmed (Supabase →
  Authentication → Users shows your accounts).
- **"No community with that code"** → the join code is the community name in
  lowercase-with-dashes. The host's Home screen shows the exact code.

That's it. When you're ready, we add seasons → weekend sign-ups → draft →
leaderboard → tournament, all on top of this.
