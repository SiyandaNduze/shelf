# Shelf — anime tracker

Catalog: every anime on AniList (live search, ~20k+ titles, real cover art).
Storage: SQLite. Browser = SQLite (sql.js) saved in IndexedDB. Phone app = native SQLite (Capacitor).
Offline: your list, anything you've viewed, and the covers you've seen all work without a connection.

## 1. Turn on login + sync (free)

1. Create a free project at [Supabase](https://supabase.com).
2. In **SQL Editor**, run `supabase.sql` once. It creates the per-user cloud row and enables Row Level Security.
3. In **Project Settings → API**, copy the **Project URL** and **publishable key** into `CFG` at the top of `app.js`. Never use a `service_role` or secret key in this public repository.
4. In **Authentication → URL Configuration**, set **Site URL** to your deployed GitHub Pages URL and add that exact URL under **Redirect URLs**, e.g. `https://YOUR-USERNAME.github.io/shelf/`.
5. In **Integrations → Data API** (or **API → Data API**), make sure `public.shelf_data` is exposed. The SQL file grants `authenticated` SELECT, INSERT and UPDATE privileges; RLS restricts each user to their own row.
6. Open the Account tab, create an account, and sign in on every device with the same account.

If you already created `shelf_data` using the earlier SQL, do not recreate the table or policy. Run just this in SQL Editor if sync reports a permissions error:

```sql
grant select, insert, update on public.shelf_data to authenticated;
```

## 2. Enable Google + GitHub sign-in

Shelf uses Supabase Auth OAuth. Create OAuth credentials with each provider, then enter them in Supabase.

Register this **callback URL with BOTH Google and GitHub**:

```
https://gbjnzkvwtmibnxsfyypt.supabase.co/auth/v1/callback
```

### Google

1. In [Google Cloud Console](https://console.cloud.google.com/), create/select a project and configure its OAuth consent screen.
2. Create an OAuth client ID of type **Web application**.
3. Add the callback URL above under **Authorized redirect URIs**.
4. Copy the Google Client ID and Client Secret.

### GitHub

1. In GitHub, open **Settings → Developer settings → OAuth Apps → New OAuth App**.
2. Set the Homepage URL to your GitHub Pages URL.
3. Set the Authorization callback URL to the callback URL above.
4. Create the app, copy its Client ID and generate a Client Secret.

### Add both providers to Supabase

1. Open **Authentication → Providers**.
2. Enable **Google** and paste its Client ID and Client Secret.
3. Enable **GitHub** and paste its Client ID and Client Secret.
4. Save both providers.

The Google and GitHub buttons return users to the current GitHub Pages page. The Supabase JavaScript client handles the PKCE callback and persists the session. Keep provider Client Secrets in Supabase only; never commit them to this repository.

## 3. Email confirmation

Email/password signup is supported. With email confirmation enabled, users receive a confirmation email and are returned to the current app URL. Supabase's client library handles the PKCE callback. You can disable email confirmation in **Authentication → Providers → Email** while testing, but re-enable it for a public app.

## 4. Run in a browser

```sh
npx serve .        # then open http://localhost:3000
```

(Service workers need localhost or https. To use it on your phone, upload this folder to GitHub Pages, open the link, and choose "Add to Home Screen".)

## 5. Real Android/iOS app with native SQLite

```sh
npm init -y
npm i @capacitor/core @capacitor/cli @capacitor-community/sqlite
npx cap init Shelf com.example.shelf --web-dir=www
mkdir www && cp index.html app.js style.css sw.js manifest.webmanifest icon.svg www/
npm i @capacitor/android      # or @capacitor/ios
npx cap add android
npx cap sync
npx cap open android          # run from Android Studio
```

app.js detects Capacitor and switches to the native SQLite plugin automatically.

Sync notes: local SQLite remains the offline copy and syncs to your account when online. Cloud writes use conditional updates to detect concurrent changes; simultaneous changes are merged where possible, and conflicts are surfaced rather than silently overwriting the cloud row. Signing out clears the device copy but leaves the cloud list in your account.

## 6. Franchise grouping and completed items

My list groups AniList-linked anime entries (such as seasons, sequels, side stories, spin-offs, and related films/OVAs/specials) into one franchise group. The Completed filter counts a group once, and only when every entry in that group is marked Completed. Individual entries remain editable inside the group. Completed entries are hidden from Browse results but remain in My list. AniList relationship data is cached locally (not uploaded to cloud sync); the app refreshes it while online. Unlinked titles remain separate rather than being guessed together by similar names.


## 7. Reliability notes

Rankings group completed franchise entries and count each completed franchise once.

- Browse automatically fetches replacement results after an anime is marked Completed. Load more advances to the next AniList page without skipping a page.
- Browser writes are persisted before the database operation completes; IndexedDB failures are reported instead of being treated as successful saves. Tabs use the Web Locks API where available and an IndexedDB lease lock otherwise, and reads refresh from the shared snapshot.
- Cloud writes use a conditional update. If another device changes the cloud row during a sync, Shelf reports a conflict rather than silently overwriting the newer snapshot. A later sync merges independent additions and edits; local values win for entries edited on both devices. The current whole-snapshot format does not keep per-entry deletion tombstones, so an offline deletion can still be reintroduced by a merge.
- Franchise links are local catalog cache, not account data, and are cleared on sign-out or account switching. Ambiguous alternative adaptations are not automatically merged.
- The service worker caches successful same-origin responses only. It does not cache third-party APIs, authentication, or query-string traffic.
