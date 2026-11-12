# Shelf — anime tracker

Catalog: every anime on AniList (live search, ~20k+ titles, real cover art).
Storage: SQLite. Browser = SQLite (sql.js) saved in IndexedDB. Phone app = native SQLite (Capacitor).
Offline: your list, anything you've viewed, and the covers you've seen all work without a connection.

## Run in a browser
    npx serve .        # then open http://localhost:3000
(Service workers need localhost or https. To use it on your phone, upload this folder to
Netlify / GitHub Pages / Cloudflare Pages, open the link, and choose "Add to Home Screen".)

## Real Android/iOS app with native SQLite
    npm init -y
    npm i @capacitor/core @capacitor/cli @capacitor-community/sqlite
    npx cap init Shelf com.example.shelf --web-dir=www
    mkdir www && cp index.html app.js style.css sw.js manifest.webmanifest icon.svg www/
    npm i @capacitor/android      # or @capacitor/ios
    npx cap add android
    npx cap sync
    npx cap open android          # run from Android Studio
app.js detects Capacitor and switches to the native SQLite plugin automatically.
