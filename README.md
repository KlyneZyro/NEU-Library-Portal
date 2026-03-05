# 📚 NEU Library Visitor Portal

A web-based library attendance system for New Era University, replacing the traditional physical logbook with a digital check-in/check-out flow using Google authentication.

---

## ✨ Features

### For Students / Faculty / Staff
- **Google Sign-In** restricted to `@neu.edu.ph` accounts only
- **One-time profile setup** — user type, department, and ID number saved for all future visits
- **Reason for visit** selection before check-in
- **Live Active Pass** — displays name, ID, department, elapsed time, and check-in time
- **Auto-logout** after check-out with a 15-second countdown
- **Personal history** — view last 50 visits and all borrowed book records
- **CSV export** of personal visit history

### For Librarians / Admin
- **Admin dashboard** accessible only to accounts with `role: 'admin'` in Firestore
- **Real-time visitor log** — updates live without page refresh
- **Search and filters** — by name, email, ID, department, status, and date range
- **Force checkout** — manually end an active session
- **Ban / Unban** users with instant lockout
- **Book management** — issue books to students, track due dates, mark returns, overdue alerts
- **CSV export** of filtered admin logs

### Automatic
- **Midnight session guard** — stale sessions from previous days are auto-closed
- **Library hours badge** in the nav showing OPEN / CLOSED in real time
- **Personalised greeting** on the check-in screen
- **Live visitor count** shown on the check-in screen

---

## 🛠 Tech Stack

| Layer | Technology |
|---|---|
| Frontend | HTML, Tailwind CSS, Vanilla JavaScript (ES Modules) |
| Auth | Firebase Authentication (Google OAuth) |
| Database | Firebase Firestore (real-time) |

---

## 🚀 Setup & Deployment

### 1. Clone the repository
```bash
git clone https://github.com/your-username/NEU-Library-Portal.git
cd NEU-Library-Portal
```

### 2. Firebase configuration
The app uses Firebase. The config is already in `firebase-config.js`.  
To use your own Firebase project, replace the values in that file with your own project credentials from the [Firebase Console](https://console.firebase.google.com).

### 3. Firestore security rules
In your Firebase console, set your Firestore rules to restrict access:
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
      allow read: if request.auth != null
                  && get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin';
    }
    match /logs/{logId} {
      allow read, write: if request.auth != null;
    }
    match /borrowed_books/{bookId} {
      allow read, write: if request.auth != null;
    }
  }
}
```

### 4. Setting an admin account
In Firebase Console → Firestore → `users` collection, find your user document and manually set:
```
role: "admin"
```

### 5. Deploy to GitHub Pages
- Go to your repo → **Settings** → **Pages**
- Set source to **main branch / root**
- Your site will be live at `https://your-username.github.io/NEU-Library-Portal`

---

## 📁 Project Structure
```
NEU-Library-Portal/
├── index.html          # All UI views (login, check-in, pass, admin, history)
├── app.js              # All logic, Firebase calls, event handlers
├── firebase-config.js  # Firebase project credentials
└── style.css           # Custom styles (branding, ticket divider, animations)
```

---

## 🔐 Security Notes

- Email domain is enforced — only `@neu.edu.ph` accounts can sign in
- Admin role is set **only** via Firebase console — users cannot self-elevate
- Blocked users are locked out immediately on next auth state check
- All Firestore writes are authenticated

---

## 👤 Author

**Klyne Zyro C. Reyes**  
Bachelor of Science in Computer Science
New Era University  

---

## 📄 License

This project was developed as an academic requirement.  
© 2025 New Era University — All rights reserved.
