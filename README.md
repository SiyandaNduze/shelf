# Shelf — anime tracker

Catalog: every anime on AniList (live search, ~20k+ titles, real cover art).
Storage: SQLite. Browser = SQLite (sql.js) saved in IndexedDB. Phone app = native SQLite (Capacitor).
Offline: your list, anything you've viewed, and the covers you've seen all work without a connection.

## 1. Turn on login + sync (free, ~5 minutes)
1. Create a free project at supabase.com.
2. SQL Editor: paste and run `supabase.sql` (creates one table, locked so each user only sees their own row).
3. Project Settings > API: copy the **Project URL** and the **anon public key** into `CFG` at the top of `app.js`.
4. Optional: Authentication > Providers > Email > turn off "Confirm email" if you don't want a confirmation email on sign-up.
Then open the Account tab, create an account, and sign in on every device with the same email and password.

## 2. Run in a browser
    npx serve .        # then open http://localhost:3000
(Service workers need localhost or https. To use it on your phone, upload this folder to
Netlify / GitHub Pages / Cloudflare Pages, open the link, and choose "Add to Home Screen".)

## 3. Real Android/iOS app with native SQLite
    npm init -y
    npm i @capacitor/core @capacitor/cli @capacitor-community/sqlite
    npx cap init Shelf com.example.shelf --web-dir=www
    mkdir www && cp index.html app.js style.css sw.js manifest.webmanifest icon.svg www/
    npm i @capacitor/android      # or @capacitor/ios
    npx cap add android
    npx cap sync
    npx cap open android          # run from Android Studio
app.js detects Capacitor and switches to the native SQLite plugin automatically.

Sync notes: the local SQLite database stays the main copy (so everything works offline) and is synced to your account when you're online. Newest change wins; signing out clears the device (your list stays in your account).