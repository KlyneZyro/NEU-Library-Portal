# 📚 NEU Library Visitor Portal
 
A web-based library attendance and visitor tracking system for New Era University.  
Replaces the traditional physical logbook with a fully digital check-in/check-out flow using Google authentication, real-time Firestore sync, and a live admin dashboard.
 
---
 
## 🔗 Live Demo
 
> https://klynezyro.github.io/NEU-Library-Portal/
 
---
 
## ✨ Features
 
### For Students / Faculty / Staff / Visitors
- **Google Sign-In** restricted to `@neu.edu.ph` accounts only
- **Pre-block check on login** — pre-blocked emails are denied access even on first sign-in
- **One-time profile setup** — user type (Student, Faculty, Employee, Visitor), department, and ID number are locked after first save and carried across all future visits
- **Reason for visit** selection via tap-to-select buttons before check-in
- **Live Active Pass** — displays name, ID, department, elapsed time, check-in time, and borrowed books
- **Auto-logout** after check-out with a 15-second countdown and librarian confirmation screen
- **Personal visit history** — last 50 visits and complete borrowed books history in one panel
- **CSV export** of personal visit history
 
### For Librarians / Admins
The admin panel is accessible only to accounts with `role: 'admin'` set in Firestore. It has four tabs:
 
#### 📋 Logs Tab
- **Live visitor log** — updates in real time without page refresh
- **Stats bar** — current active visitors, today's total, and total records loaded
- **Search and filters** — by name, email, ID, department, status, and date range
- **Force checkout** — manually end any active session
- **Ban / Unban** users directly from the log table
- **CSV export** of filtered log data
 
#### 👥 Users Tab
- **Search registered users** by name, email, or ID — filter by user type and role
- **Change role** — promote a user to Admin or demote back to User
- **Change user type** — correct a mislabelled Student / Faculty / Employee / Visitor
- **Ban / Unban** — suspend or reinstate account access
 
#### 📚 Books Tab
- **Issue books** to registered users — validates the email exists in the system
- **Track active borrowed books** — sorted by due date, overdue entries highlighted
- **Mark returned** — one-click return from the admin table
 
#### 🚫 Blocked Tab
- **Pre-block an email address** before they ever register — they are denied at login with a clear error message. If the email is already registered, their account is also suspended simultaneously
- **View and remove** pre-blocked emails
- **View all suspended registered users** with one-click unban
 
### Automatic / Background
- **Kiosk mode** — every page load forces a sign-out of any cached browser session, so students cannot skip the login screen
- **Midnight session guard** — stale active sessions from previous days are auto-closed on next login
- **Library hours badge** in the nav showing OPEN / CLOSED based on NEU library operating hours
- **Personalised greeting** with time-of-day message on the check-in screen
- **Live visitor count** shown on the check-in screen
 
---
 
## 🛠 Tech Stack
 
| Layer | Technology |
|---|---|
| Frontend | HTML, Tailwind CSS, Vanilla JavaScript (ES Modules) |
| Auth | Firebase Authentication (Google OAuth) |
| Database | Firebase Firestore (real-time) |
| Hosting | GitHub Pages |
 
---
 
## 🚀 Setup & Deployment
 
### 1. Clone the repository
```bash
git clone https://github.com/klynezyro/NEU-Library-Portal.git
cd NEU-Library-Portal
```
 
### 2. Firebase configuration
The app uses Firebase. The config is already in `firebase-config.js`.  
To use your own Firebase project, replace the values in that file with your own project credentials from the [Firebase Console](https://console.firebase.google.com).
 
### 3. Firestore security rules
Copy and paste these rules into **Firebase Console → Firestore → Rules**.  
They enforce domain restriction, prevent self-promotion, lock immutable log fields, and protect the blocked emails list.
 
```js
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
 
    function isAuthenticated() {
      return request.auth != null
          && request.auth.token.email.matches('.*@neu[.]edu[.]ph');
    }
 
    function isAdmin() {
      return isAuthenticated()
          && exists(/databases/$(database)/documents/users/$(request.auth.uid))
          && get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin';
    }
 
    function isOwner(uid) {
      return isAuthenticated() && request.auth.uid == uid;
    }
 
    match /users/{uid} {
      allow read: if isOwner(uid) || isAdmin();
      allow create: if isOwner(uid)
                    && request.resource.data.role == 'user'
                    && request.resource.data.isBlocked == false;
      allow update: if isAdmin()
                    || (isOwner(uid)
                        && request.resource.data.role      == resource.data.role
                        && request.resource.data.isBlocked == resource.data.isBlocked);
      allow delete: if isAdmin();
    }
 
    match /logs/{logId} {
      allow read: if isAuthenticated()
                  && (resource.data.uid == request.auth.uid || isAdmin());
      allow create: if isAuthenticated()
                    && request.resource.data.uid == request.auth.uid;
      allow update: if isAdmin()
                    || (isAuthenticated()
                        && resource.data.uid == request.auth.uid
                        && request.resource.data.uid        == resource.data.uid
                        && request.resource.data.email      == resource.data.email
                        && request.resource.data.fullName   == resource.data.fullName
                        && request.resource.data.department == resource.data.department
                        && request.resource.data.status     == 'Completed');
      allow delete: if isAdmin();
    }
 
    match /borrowed_books/{bookId} {
      allow read: if isAuthenticated()
                  && (resource.data.uid == request.auth.uid || isAdmin());
      allow write: if isAdmin();
    }
 
    match /blocked_emails/{emailId} {
      allow read:  if isAuthenticated();
      allow write: if isAdmin();
    }
  }
}
```
 
### 4. Setting an admin account
In Firebase Console → Firestore → `users` collection, find your user document and manually set:
```
role: "admin"
```
This is the **only** way to grant admin access. Users cannot self-promote through the app.
 
### 5. Deploy to GitHub Pages
Push your changes to the `main` branch. GitHub Pages auto-deploys on every push — the live site updates within 1–2 minutes.
 
To update only the files that changed:
```bash
git add app.js index.html
git commit -m "your message here"
git push
```
 
---
 
## 📁 Project Structure
 
```
NEU-Library-Portal/
├── index.html          # All UI views (login, onboarding, check-in, pass, checkout, history, admin)
├── app.js              # All logic — Firebase calls, auth router, event handlers, admin features
├── firebase-config.js  # Firebase project credentials
└── style.css           # Custom styles (NEU branding, ticket divider, animations)
```
 
---
 
## 🗄️ Firestore Database Schema
 
### `users` collection
| Field | Type | Description |
|---|---|---|
| `uid` | String | Firebase Auth UID |
| `email` | String | Must end in `@neu.edu.ph` |
| `fullName` | String | From Google account |
| `userType` | String | `student`, `faculty`, `employee`, `visitor` |
| `department` | String | e.g. `BSCS`, `BSIT`, `N/A` for visitors |
| `studentId` | String | ID number (required for students) |
| `onboardingCompleted` | Boolean | Locks profile from being re-setup |
| `role` | String | `user` (default) or `admin` — set manually in console only |
| `isBlocked` | Boolean | `false` by default; `true` = locked out |
| `createdAt` | Timestamp | First registration time |
 
### `logs` collection
| Field | Type | Description |
|---|---|---|
| `logId` | String | Auto-generated document ID |
| `uid` | String | Owner's Firebase UID |
| `email` | String | Owner's email |
| `fullName` | String | Snapshot at time of check-in |
| `userType` | String | Snapshot at time of check-in |
| `department` | String | Snapshot at time of check-in |
| `studentId` | String | Snapshot at time of check-in |
| `reason` | String | Purpose of visit |
| `checkInTimestamp` | Timestamp | When they entered |
| `checkOutTimestamp` | Timestamp \| null | When they exited |
| `status` | String | `Active` or `Completed` |
| `autoClosed` | Boolean | `true` if closed by midnight guard |
| `forcedByAdmin` | Boolean | `true` if admin force-checked them out |
 
### `borrowed_books` collection
| Field | Type | Description |
|---|---|---|
| `uid` | String | Borrower's Firebase UID |
| `userEmail` | String | Borrower's email |
| `bookTitle` | String | Title or ISBN |
| `borrowDate` | Timestamp | When issued |
| `dueDate` | Timestamp | Return deadline |
| `status` | String | `Borrowed` or `Returned` |
 
### `blocked_emails` collection
| Field | Type | Description |
|---|---|---|
| `email` | String | The blocked `@neu.edu.ph` address |
| `reason` | String | Optional reason entered by admin |
| `blockedAt` | Timestamp | When the block was created |
| `blockedBy` | String | Email of the admin who blocked it |
 
---
 
## 🔐 Security Notes
 
- Email domain is enforced at both the app level and Firestore rules level
- Admin role is set **only** via Firebase console — users cannot self-promote through any UI action or direct Firestore write
- Users cannot modify their own `role` or `isBlocked` fields — Firestore rules explicitly block this
- Blocked users are locked out immediately on next auth state check, even mid-session
- Log fields like `uid`, `email`, `fullName`, and `department` are immutable after creation — users can only update `status` to `Completed`
- All Firestore strings rendered in the DOM are HTML-escaped to prevent XSS
- Every page load forces a fresh sign-in (kiosk mode) — cached browser sessions never bypass the login screen
 
---
 
## 👤 Author
 
**Klyne Zyro Reyes**  
Bachelor of Science in Computer Science  
New Era University
 
---
 
## 📄 License
 
This project was developed as an academic requirement.  
© 2026 New Era University — All rights reserved.
