import { auth, db, provider } from './firebase-config.js';
import { onAuthStateChanged, signInWithPopup, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
    doc, getDoc, setDoc, updateDoc, collection, query, where,
    getDocs, addDoc, serverTimestamp, limit, orderBy, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// ─── MODULE-LEVEL STATE ────────────────────────────────────────────────────────
let selectedType    = '';
let selectedDept    = '';
let selectedReason  = '';
let clockInterval   = null;
let countdownInterval = null;  // module-level so performLogout() can always clear it
let elapsedSeconds  = 0;
let currentUser     = null;
let currentLogId    = null;
let currentLogData  = null;
let logoutTimer     = null;
let adminUnsubscribe = null;
let allAdminLogs    = [];


// ─── UTILITY ──────────────────────────────────────────────────────────────────

function showToast(title, message, type = 'success') {
    const toast = document.getElementById('toast');
    const icons  = { success: '✓', error: '⚠️', info: 'ℹ️', warning: '⚡' };
    const colors = { success: '#10b981', error: '#ef4444', info: '#3b82f6', warning: '#f59e0b' };
    document.getElementById('toast-icon').textContent    = icons[type]  || icons.info;
    document.getElementById('toast-title').textContent   = title;
    document.getElementById('toast-message').textContent = message;
    toast.querySelector('.border-l-4').style.borderColor = colors[type] || colors.info;
    toast.classList.remove('hidden');
    setTimeout(() => toast.classList.add('hidden'), 5000);
}
window.hideToast = () => document.getElementById('toast').classList.add('hidden');

function toggleLoading(show) {
    document.getElementById('loading-overlay').classList.toggle('hidden', !show);
}

function showView(id) {
    const views = [
        'login-ui', 'blocked-ui', 'onboarding-ui', 'checkin-ui',
        'active-pass-ui', 'checkout-success-ui', 'history-ui', 'admin-ui'
    ];
    views.forEach(v => document.getElementById(v).classList.add('hidden'));
    document.getElementById(id).classList.remove('hidden');

    const isLoggedIn = id !== 'login-ui' && id !== 'blocked-ui';
    document.getElementById('historyBtn').classList.toggle('hidden', !isLoggedIn);

    // Reset check-in state whenever this view is shown
    if (id === 'checkin-ui') {
        selectedReason = '';
        document.querySelectorAll('.reason-btn').forEach(b => b.classList.remove('selected'));
        document.getElementById('customReason').value = '';
        document.getElementById('customReason').classList.add('hidden');
        const confirmBtn = document.getElementById('confirmCheckIn');
        confirmBtn.classList.add('hidden');
        confirmBtn.disabled = false; // always re-enable on nav back
        // Load greeting and visitor count each time check-in appears
        updateCheckinGreeting();
        loadCurrentVisitors();
    }

    // Reset onboarding state whenever shown
    if (id === 'onboarding-ui') {
        selectedType = '';
        selectedDept = '';
        document.querySelectorAll('.type-btn, .dept-btn').forEach(b => b.classList.remove('selected'));
        document.getElementById('deptSection').classList.add('hidden');
        document.getElementById('studentIdField').classList.add('hidden');
        document.getElementById('studentIdInput').value = '';
        const saveBtn = document.getElementById('saveProfileBtn');
        saveBtn.disabled = true;
        saveBtn.classList.add('opacity-40', 'cursor-not-allowed');
    }

    // Tear down admin snapshot when leaving admin view
    if (id !== 'admin-ui' && adminUnsubscribe) {
        adminUnsubscribe();
        adminUnsubscribe = null;
    }

    if (currentUser) checkAdminAccess();
}

// Admin access is ONLY granted by role === 'admin' in Firestore — never by self-declared userType
async function checkAdminAccess() {
    try {
        const userDoc = await getDoc(doc(db, 'users', currentUser.uid));
        const isAdmin = userDoc.data()?.role === 'admin';
        document.getElementById('adminBtn').classList.toggle('hidden', !isAdmin);
    } catch (e) {
        console.error('Admin check error:', e);
    }
}


// ─── LIBRARY STATUS BADGE ─────────────────────────────────────────────────────
// Shows "OPEN" or "CLOSED" in the nav based on NEU library operating hours.
// No Firestore read needed — pure time calculation.

function updateLibraryStatus() {
    const badge = document.getElementById('lib-status-badge');
    if (!badge) return;

    const now  = new Date();
    const day  = now.getDay();   // 0=Sun, 1=Mon…6=Sat
    const hour = now.getHours();
    const min  = now.getMinutes();
    const timeNum = hour * 100 + min; // e.g. 14:30 → 1430

    let isOpen = false;
    if (day >= 1 && day <= 5) {         // Mon–Fri: 7:00 AM – 8:00 PM
        isOpen = timeNum >= 700 && timeNum < 2000;
    } else if (day === 6) {             // Saturday: 8:00 AM – 5:00 PM
        isOpen = timeNum >= 800 && timeNum < 1700;
    }
    // Sunday: always closed

    badge.classList.remove('hidden', 'bg-green-400', 'bg-red-400', 'text-white');
    if (isOpen) {
        badge.classList.add('bg-green-400', 'text-white');
        badge.textContent = '● OPEN';
    } else {
        badge.classList.add('bg-red-400', 'text-white');
        badge.textContent = '● CLOSED';
    }
}


// ─── CHECK-IN GREETING ────────────────────────────────────────────────────────
// Shows a personalised time-of-day greeting using the logged-in user's first name.

function updateCheckinGreeting() {
    const el = document.getElementById('checkin-greeting');
    if (!el) return;

    const hour = new Date().getHours();
    let greet = 'Good evening';
    if (hour < 12) greet = 'Good morning';
    else if (hour < 17) greet = 'Good afternoon';

    const firstName = currentUser?.displayName?.split(' ')[0] || 'there';
    el.textContent = `${greet}, ${firstName}! 👋`;
}


// ─── CURRENT VISITORS COUNT ───────────────────────────────────────────────────
// Single one-time read when check-in view loads — shows how many are in library.

async function loadCurrentVisitors() {
    const badge = document.getElementById('current-visitors-badge');
    const count = document.getElementById('current-visitors-count');
    if (!badge || !count) return;

    try {
        const q    = query(collection(db, 'logs'), where('status', '==', 'Active'));
        const snap = await getDocs(q);
        count.textContent = snap.size;
        badge.classList.remove('hidden');
    } catch (e) {
        badge.classList.add('hidden'); // fail silently — not critical
    }
}


// ─── BORROWED BOOKS WIDGET ────────────────────────────────────────────────────

async function loadUserBooks(uid) {
    const containers = [
        document.getElementById('user-books-list-checkin'),
        document.getElementById('user-books-list-active')
    ];
    try {
        const q    = query(collection(db, 'borrowed_books'), where('uid', '==', uid), where('status', '==', 'Borrowed'));
        const snap = await getDocs(q);
        let html   = '';

        if (snap.empty) {
            html = '<p class="text-slate-400 italic text-xs border border-dashed rounded-lg p-3 bg-slate-50">No books currently borrowed.</p>';
        } else {
            const now = new Date();
            snap.forEach(docSnap => {
                const book = docSnap.data();
                if (!book.dueDate) return;   // null guard
                const due       = book.dueDate.toDate();
                const isOverdue = due < now;
                html += `
                    <div class="p-2.5 border rounded-xl ${isOverdue ? 'bg-red-50 border-red-200' : 'bg-white border-slate-200'} flex justify-between items-center shadow-sm">
                        <div>
                            <p class="font-bold text-xs ${isOverdue ? 'text-red-700' : 'text-[#0a2d5e]'}">${book.bookTitle}</p>
                            <p class="text-[10px] text-slate-500">Due: ${due.toLocaleDateString()}</p>
                        </div>
                        ${isOverdue ? '<span class="text-[9px] font-black bg-red-600 text-white px-2 py-0.5 rounded-lg uppercase tracking-widest animate-pulse-fast">⚠ Overdue</span>' : ''}
                    </div>`;
            });
        }
        containers.forEach(el => { if (el) el.innerHTML = html; });
    } catch (e) {
        console.error('loadUserBooks error:', e);
    }
}


// ─── AUTH STATE ROUTER ────────────────────────────────────────────────────────
// *** KIOSK FIX ***
// Firebase persists auth sessions to IndexedDB. Without this signOut(), the
// cached session (e.g. "Reyes") fires onAuthStateChanged immediately on every
// page load, bypassing the login screen entirely.
// By signing out first and THEN attaching the listener, we guarantee the page
// always starts at the login screen and the user must actively authenticate.
signOut(auth).finally(() => {

onAuthStateChanged(auth, async (user) => {
    if (user) {
        currentUser = user;

        // Non-NEU email — show inline error and kick them out immediately
        if (!user.email.endsWith('@neu.edu.ph')) {
            const errEl    = document.getElementById('login-error-msg');
            const detailEl = document.getElementById('login-error-detail');
            if (errEl && detailEl) {
                detailEl.textContent = `"${user.email}" is not a valid NEU email. Please sign in with your @neu.edu.ph account.`;
                errEl.classList.remove('hidden');
            }
            const btnText = document.getElementById('loginBtnText');
            const btn     = document.getElementById('loginBtn');
            if (btnText) btnText.textContent = 'Sign in with Google';
            if (btn)     btn.disabled = false;
            await signOut(auth);
            return; // onAuthStateChanged(null) will show login-ui
        }

        // Clear any stale login error message
        const errEl = document.getElementById('login-error-msg');
        if (errEl) errEl.classList.add('hidden');

        try {
            toggleLoading(true);
            const userDocRef = doc(db, 'users', user.uid);
            const userDoc    = await getDoc(userDocRef);

            if (!userDoc.exists() || !userDoc.data().onboardingCompleted) {
                toggleLoading(false);
                showView('onboarding-ui');
                return;
            }

            const userData = userDoc.data();

            if (userData.isBlocked === true) {
                toggleLoading(false);
                showView('blocked-ui');
                return;
            }

            await loadUserBooks(user.uid);
            await checkActiveLog(user.uid); // manages its own toggleLoading

        } catch (error) {
            console.error('Auth state error:', error);
            toggleLoading(false);
            showToast('Error', 'Failed to load your profile. Please try again.', 'error');
        }

    } else {
        // Signed out — reset all state and return to login screen
        currentUser    = null;
        currentLogId   = null;
        currentLogData = null;
        toggleLoading(false);
        showView('login-ui');
        updateLibraryStatus();
    }
});

}); // end of signOut().finally()

// Refresh library status badge every minute
setInterval(updateLibraryStatus, 60000);
updateLibraryStatus(); // run once immediately on load


// ─── MIDNIGHT GUARD + ACTIVE LOG ──────────────────────────────────────────────

async function checkActiveLog(uid) {
    toggleLoading(true);
    try {
        // Re-verify blocked status here as well — a user could be blocked by an admin
        // while they already have an active pass. This catches them on next page load.
        const userSnap = await getDoc(doc(db, 'users', uid));
        if (userSnap.exists() && userSnap.data().isBlocked === true) {
            toggleLoading(false);
            showView('blocked-ui');
            return;
        }

        const q    = query(collection(db, 'logs'), where('uid', '==', uid), where('status', '==', 'Active'));
        const snap = await getDocs(q);

        if (!snap.empty) {
            const logDoc  = snap.docs[0];
            const logData = logDoc.data();
            const checkInDate = logData.checkInTimestamp?.toDate().toDateString();
            const todayDate   = new Date().toDateString();

            if (checkInDate && checkInDate !== todayDate) {
                await updateDoc(doc(db, 'logs', logDoc.id), {
                    status: 'Completed',
                    checkOutTimestamp: serverTimestamp(),
                    autoClosed: true
                });
                showToast('Session Expired', 'Your previous session was auto-closed at midnight.', 'info');
                showView('checkin-ui');
            } else {
                currentLogId   = logDoc.id;
                currentLogData = logData;
                renderActivePass(logData, logDoc.id);
            }
        } else {
            showView('checkin-ui');
        }
    } catch (error) {
        console.error('checkActiveLog error:', error);
        showView('checkin-ui');
    } finally {
        toggleLoading(false);
    }
}


// ─── CHECK-IN ─────────────────────────────────────────────────────────────────

document.getElementById('confirmCheckIn').onclick = async () => {
    const customText  = document.getElementById('customReason').value.trim();
    const confirmBtn  = document.getElementById('confirmCheckIn');

    if (!selectedReason)                             return showToast('Validation', 'Please select a reason for your visit.', 'warning');
    if (selectedReason === 'Others' && !customText)  return showToast('Validation', 'Please specify your reason.', 'warning');
    if (customText.length > 100)                     return showToast('Validation', 'Reason is too long (max 100 characters).', 'warning');

    confirmBtn.disabled = true;
    toggleLoading(true);

    try {
        const userSnap = await getDoc(doc(db, 'users', currentUser.uid));
        const userData = userSnap.data();

        if (userData.isBlocked) {
            toggleLoading(false);
            window.location.reload();
            return;
        }

        await addDoc(collection(db, 'logs'), {
            uid:               currentUser.uid,
            email:             currentUser.email,
            fullName:          userData.fullName   || 'N/A',
            userType:          userData.userType   || 'N/A',
            department:        userData.department || 'N/A',
            studentId:         userData.studentId  || '',
            reason:            selectedReason === 'Others' ? customText : selectedReason,
            checkInTimestamp:  serverTimestamp(),
            status:            'Active',
            autoClosed:        false
        });

        showToast('Success', 'Checked in successfully!', 'success');
        await checkActiveLog(currentUser.uid);

    } catch (error) {
        console.error('Check-in error:', error);
        showToast('Error', 'Failed to check in. Please try again.', 'error');
        confirmBtn.disabled = false;
    } finally {
        toggleLoading(false);
    }
};


// ─── ACTIVE PASS ──────────────────────────────────────────────────────────────

// checkInTime is passed in so the elapsed counter can reference the actual moment
function startClock(elementId, checkInTime) {
    if (clockInterval) clearInterval(clockInterval);
    elapsedSeconds = 0;

    clockInterval = setInterval(() => {
        const now = new Date();

        const clockEl   = document.getElementById(elementId);
        const dateEl    = document.getElementById('live-date');
        const elapsedEl = document.getElementById('pass-elapsed');

        if (clockEl) clockEl.innerText = now.toLocaleTimeString();
        if (dateEl)  dateEl.innerText  = now.toLocaleDateString('en-US', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
        });

        // Elapsed time counter on the pass
        if (elapsedEl && checkInTime) {
            const elapsed = Math.floor((now - checkInTime) / 1000);
            const h = Math.floor(elapsed / 3600);
            const m = Math.floor((elapsed % 3600) / 60);
            const s = elapsed % 60;
            elapsedEl.innerText = h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`;
        }
    }, 1000);
}

function renderActivePass(log, logId) {
    document.getElementById('pass-name').innerText   = log.fullName   || 'N/A';
    document.getElementById('pass-type').innerText   = (log.userType  || '').toUpperCase();
    document.getElementById('pass-dept').innerText   = log.department || 'N/A';
    document.getElementById('pass-reason').innerText = log.reason     || 'N/A';

    const idEl = document.getElementById('pass-student-id');
    if (idEl) idEl.innerText = log.studentId ? `ID: ${log.studentId}` : '';

    const checkInTime = log.checkInTimestamp?.toDate() || null;
    const checkinEl   = document.getElementById('pass-checkin-time');
    if (checkinEl) checkinEl.innerText = checkInTime ? checkInTime.toLocaleTimeString() : '---';

    startClock('live-clock', checkInTime); // pass checkInTime so elapsed counter works
    document.getElementById('checkoutBtn').onclick = () => handleCheckout(logId, checkInTime);
    showView('active-pass-ui');
}


// ─── CHECKOUT ─────────────────────────────────────────────────────────────────

async function handleCheckout(logId, checkInTime) {
    // Confirm before writing — one accidental tap permanently closes the session
    if (!confirm('Are you sure you want to check out and exit the library?')) return;

    const checkoutBtn = document.getElementById('checkoutBtn');
    checkoutBtn.disabled = true;
    const now = new Date();
    toggleLoading(true);

    try {
        await updateDoc(doc(db, 'logs', logId), {
            status: 'Completed',
            checkOutTimestamp: serverTimestamp()
        });

        if (clockInterval) { clearInterval(clockInterval); clockInterval = null; }

        const durationMs  = checkInTime ? (now - checkInTime) : 0;
        const totalMins   = Math.floor(durationMs / 60000);
        const hours       = Math.floor(totalMins / 60);
        const minutes     = totalMins % 60;

        document.getElementById('entry-time').innerText      = checkInTime ? checkInTime.toLocaleTimeString() : 'N/A';
        document.getElementById('exit-time').innerText       = now.toLocaleTimeString();
        document.getElementById('duration-display').innerText = hours > 0 ? `${hours}h ${minutes}m` : `${totalMins} minute${totalMins !== 1 ? 's' : ''}`;

        toggleLoading(false);
        showView('checkout-success-ui');

        // Countdown — module-level so performLogout() can always clear it
        let countdown = 15;
        const cdEl    = document.getElementById('logout-countdown');
        if (cdEl) cdEl.innerText = countdown;

        if (countdownInterval) clearInterval(countdownInterval);
        countdownInterval = setInterval(() => {
            countdown--;
            if (cdEl) cdEl.innerText = countdown;
            if (countdown <= 0) {
                clearInterval(countdownInterval);
                countdownInterval = null;
            }
        }, 1000);

        if (logoutTimer) clearTimeout(logoutTimer);
        logoutTimer = setTimeout(async () => {
            if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
            await performLogout();
        }, 15000);

        currentLogId   = null;
        currentLogData = null;

    } catch (error) {
        console.error('Checkout error:', error);
        showToast('Error', 'Failed to check out. Please try again.', 'error');
        checkoutBtn.disabled = false;
        toggleLoading(false);
    }
}

async function performLogout() {
    if (logoutTimer)       { clearTimeout(logoutTimer);         logoutTimer       = null; }
    if (countdownInterval) { clearInterval(countdownInterval);  countdownInterval = null; }
    if (clockInterval)     { clearInterval(clockInterval);      clockInterval     = null; }
    if (adminUnsubscribe)  { adminUnsubscribe();                 adminUnsubscribe  = null; }

    // Reset all module state so nothing from this session leaks into the next
    currentUser    = null;
    currentLogId   = null;
    currentLogData = null;
    allAdminLogs   = [];

    try {
        toggleLoading(true);
        await signOut(auth);
        sessionStorage.clear();
        localStorage.clear();
        setTimeout(() => window.location.reload(), 300);
    } catch (error) {
        console.error('Logout error:', error);
        toggleLoading(false);
    }
}
window.performLogout = performLogout;


// ─── HISTORY ──────────────────────────────────────────────────────────────────

document.getElementById('historyBtn').onclick = async () => {
    showView('history-ui');
    await loadHistory();
};

document.getElementById('closeHistoryBtn').onclick = () => {
    if (currentLogId) showView('active-pass-ui');
    else showView('checkin-ui');
};

async function loadHistory() {
    const historyList    = document.getElementById('history-list');
    const bookHistoryList = document.getElementById('book-history-list');
    historyList.innerHTML     = '<p class="text-center text-slate-400 py-4 text-sm">Loading visits...</p>';
    bookHistoryList.innerHTML = '<p class="text-center text-slate-400 py-4 text-sm">Loading books...</p>';

    try {
        // BUGFIX: Removed orderBy() — combining where() + orderBy() on different fields
        // requires a manual composite Firestore index that users may not have created.
        // Instead we fetch with limit(50) and sort client-side in JS.
        const qLogs   = query(
            collection(db, 'logs'),
            where('uid', '==', currentUser.uid),
            limit(50)
            // NO orderBy here — avoids composite index requirement
        );
        const snapLogs = await getDocs(qLogs);

        if (snapLogs.empty) {
            historyList.innerHTML = '<p class="text-center text-slate-400 py-4 text-sm italic">No library visits recorded yet.</p>';
        } else {
            // Sort newest-first in JS (safe because limit is small)
            const logs = [];
            snapLogs.forEach(d => logs.push({ id: d.id, ...d.data() }));
            logs.sort((a, b) => (b.checkInTimestamp?.toDate() || 0) - (a.checkInTimestamp?.toDate() || 0));

            historyList.innerHTML = '';
            logs.forEach(log => {
                const checkIn  = log.checkInTimestamp?.toDate();
                const checkOut = log.checkOutTimestamp?.toDate();
                const card     = document.createElement('div');
                card.className = `p-3 border rounded-xl bg-white shadow-sm ${log.status === 'Active' ? 'border-l-4 border-green-400' : 'border-slate-200'}`;
                card.innerHTML = `
                    <div class="flex justify-between items-start mb-1">
                        <p class="font-bold text-sm text-[#0a2d5e]">${log.reason || 'N/A'}</p>
                        <span class="text-[9px] font-black px-2 py-1 uppercase rounded-lg ${log.status === 'Active' ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}">${log.status}</span>
                    </div>
                    <p class="text-xs text-slate-600 font-medium">In: ${checkIn ? checkIn.toLocaleString() : 'N/A'}</p>
                    ${checkOut ? `<p class="text-xs text-slate-500">Out: ${checkOut.toLocaleString()}</p>` : ''}
                    ${log.autoClosed    ? '<p class="text-[10px] text-orange-600 font-bold mt-1">⚠ Auto-closed at midnight</p>' : ''}
                    ${log.forcedByAdmin ? '<p class="text-[10px] text-red-600 font-bold mt-1">⚠ Forced checkout by Admin</p>'   : ''}
                `;
                historyList.appendChild(card);
            });
        }

        // BUGFIX: Removed orderBy() from borrowed books query for the same reason.
        const qBooks   = query(
            collection(db, 'borrowed_books'),
            where('uid', '==', currentUser.uid)
            // NO orderBy here
        );
        const snapBooks = await getDocs(qBooks);

        if (snapBooks.empty) {
            bookHistoryList.innerHTML = '<p class="text-center text-slate-400 py-4 text-sm italic">No borrowed books history.</p>';
        } else {
            const books = [];
            snapBooks.forEach(d => books.push({ id: d.id, ...d.data() }));
            // Sort newest borrow first — use .toDate?.() to handle both Timestamp and JS Date
            books.sort((a, b) => (b.borrowDate?.toDate?.() || 0) - (a.borrowDate?.toDate?.() || 0));

            bookHistoryList.innerHTML = '';
            const now = new Date();
            books.forEach(book => {
                const borrowDate = book.borrowDate?.toDate?.();
                const due        = book.dueDate ? book.dueDate.toDate() : null; // null guard
                const isOverdue  = book.status === 'Borrowed' && due && due < now;

                const card = document.createElement('div');
                card.className = `p-3 border rounded-xl bg-white shadow-sm ${isOverdue ? 'border-l-4 border-red-400' : 'border-slate-200'}`;
                card.innerHTML = `
                    <div class="flex justify-between items-start mb-1">
                        <p class="font-bold text-sm ${isOverdue ? 'text-red-700' : 'text-[#0a2d5e]'}">${book.bookTitle || 'Unknown Title'}</p>
                        <span class="text-[9px] font-black px-2 py-1 uppercase rounded-lg ${book.status === 'Borrowed' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-500'}">${book.status || 'N/A'}</span>
                    </div>
                    <p class="text-xs text-slate-600">Borrowed: ${borrowDate ? borrowDate.toLocaleDateString() : 'N/A'}</p>
                    <p class="text-xs ${isOverdue ? 'text-red-600 font-bold' : 'text-slate-500'}">Due: ${due ? due.toLocaleDateString() : 'N/A'}${isOverdue ? ' — OVERDUE' : ''}</p>
                `;
                bookHistoryList.appendChild(card);
            });
        }

    } catch (error) {
        console.error('loadHistory error:', error);
        showToast('Error', 'Failed to load history.', 'error');
    }
}


// ─── CSV EXPORT ───────────────────────────────────────────────────────────────

document.getElementById('exportHistoryBtn').onclick = async () => {
    try {
        toggleLoading(true);
        // BUGFIX: No orderBy — same composite-index issue. Sort in JS after fetch.
        const q    = query(collection(db, 'logs'), where('uid', '==', currentUser.uid), limit(500));
        const snap = await getDocs(q);

        const logs = [];
        snap.forEach(d => logs.push(d.data()));
        logs.sort((a, b) => (b.checkInTimestamp?.toDate() || 0) - (a.checkInTimestamp?.toDate() || 0));

        const rows = [['Date', 'Check-in', 'Check-out', 'Duration (min)', 'Reason', 'Status', 'Auto-closed', 'Force-checkout']];
        logs.forEach(log => {
            const ci   = log.checkInTimestamp?.toDate();
            const co   = log.checkOutTimestamp?.toDate();
            const mins = (ci && co) ? Math.floor((co - ci) / 60000) : '';
            rows.push([
                ci ? ci.toLocaleDateString() : 'N/A',
                ci ? ci.toLocaleTimeString() : 'N/A',
                co ? co.toLocaleTimeString() : 'N/A',
                mins,
                `"${(log.reason || '').replace(/"/g, '""')}"`,
                log.status || '',
                log.autoClosed    ? 'Yes' : 'No',
                log.forcedByAdmin ? 'Yes' : 'No'
            ]);
        });
        downloadCSV(rows, `my_library_history_${getTodayStr()}.csv`);
    } catch (e) {
        console.error(e);
        showToast('Error', 'Failed to export history.', 'error');
    } finally {
        toggleLoading(false);
    }
};

document.getElementById('exportAdminBtn').onclick = async () => {
    try {
        toggleLoading(true);

        const status   = document.getElementById('filterStatus').value;
        const dept     = document.getElementById('filterDept').value;
        const search   = document.getElementById('adminSearch').value.trim().toLowerCase();
        const dateFrom = document.getElementById('filterDateFrom').value;
        const dateTo   = document.getElementById('filterDateTo').value;

        let filtered = [...allAdminLogs];
        if (status)   filtered = filtered.filter(l => l.status     === status);
        if (dept)     filtered = filtered.filter(l => l.department  === dept);
        if (search)   filtered = filtered.filter(l =>
            (l.fullName  || '').toLowerCase().includes(search) ||
            (l.email     || '').toLowerCase().includes(search) ||
            (l.studentId || '').toLowerCase().includes(search)
        );
        if (dateFrom) {
            const from = new Date(dateFrom);
            filtered = filtered.filter(l => { const t = l.checkInTimestamp?.toDate(); return t && t >= from; });
        }
        if (dateTo) {
            const to = new Date(dateTo + 'T23:59:59');
            filtered = filtered.filter(l => { const t = l.checkInTimestamp?.toDate(); return t && t <= to; });
        }

        const rows = [['Name', 'ID', 'Email', 'Type', 'Department', 'Date', 'Check-in', 'Check-out', 'Duration (min)', 'Reason', 'Status', 'Auto-closed', 'Force-checkout']];
        filtered.forEach(log => {
            const ci   = log.checkInTimestamp?.toDate();
            const co   = log.checkOutTimestamp?.toDate();
            const mins = (ci && co) ? Math.floor((co - ci) / 60000) : '';
            rows.push([
                `"${(log.fullName || '').replace(/"/g, '""')}"`,
                log.studentId  || '',
                log.email      || '',
                log.userType   || '',
                log.department || '',
                ci ? ci.toLocaleDateString() : 'N/A',
                ci ? ci.toLocaleTimeString() : 'N/A',
                co ? co.toLocaleTimeString() : 'N/A',
                mins,
                `"${(log.reason || '').replace(/"/g, '""')}"`,
                log.status || '',
                log.autoClosed    ? 'Yes' : 'No',
                log.forcedByAdmin ? 'Yes' : 'No'
            ]);
        });
        downloadCSV(rows, `library_admin_logs_${getTodayStr()}.csv`);
    } catch (e) {
        console.error(e);
        showToast('Error', 'Failed to export admin logs.', 'error');
    } finally {
        toggleLoading(false);
    }
};

function downloadCSV(rows, filename) {
    const csv  = rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Success', `${filename} downloaded.`, 'success');
}

function getTodayStr() {
    return new Date().toISOString().slice(0, 10);
}


// ─── ADMIN PANEL ──────────────────────────────────────────────────────────────

document.getElementById('adminBtn').onclick = async () => {
    showView('admin-ui');
    subscribeAdminLogs();
    await loadAdminBooks();
};

document.getElementById('closeAdminBtn').onclick = () => {
    if (adminUnsubscribe) { adminUnsubscribe(); adminUnsubscribe = null; }
    if (currentLogId) showView('active-pass-ui');
    else showView('checkin-ui');
};

// Real-time live listener. Uses orderBy WITHOUT a where clause — single-field index,
// auto-created by Firestore, so no manual index setup needed.
function subscribeAdminLogs() {
    if (adminUnsubscribe) adminUnsubscribe();

    const q = query(collection(db, 'logs'), orderBy('checkInTimestamp', 'desc'), limit(300));
    adminUnsubscribe = onSnapshot(q, snap => {
        allAdminLogs = [];
        snap.forEach(d => allAdminLogs.push({ id: d.id, ...d.data() }));
        updateAdminStats();
        applyAdminFilters();
    }, error => {
        console.error('Admin snapshot error:', error);
        showToast('Error', 'Live data connection lost. Re-open admin panel to reconnect.', 'error');
    });
}

function updateAdminStats() {
    const today      = new Date().toDateString();
    const activeLogs = allAdminLogs.filter(l => l.status === 'Active');
    const todayLogs  = allAdminLogs.filter(l => l.checkInTimestamp?.toDate().toDateString() === today);
    document.getElementById('stat-active').innerText = activeLogs.length;
    document.getElementById('stat-today').innerText  = todayLogs.length;
    document.getElementById('stat-total').innerText  = allAdminLogs.length;
}

// All filtering runs on the in-memory allAdminLogs cache — zero extra Firestore reads
function applyAdminFilters() {
    const status   = document.getElementById('filterStatus').value;
    const dept     = document.getElementById('filterDept').value;
    const search   = document.getElementById('adminSearch').value.trim().toLowerCase();
    const dateFrom = document.getElementById('filterDateFrom').value;
    const dateTo   = document.getElementById('filterDateTo').value;

    let filtered = [...allAdminLogs];
    if (status)   filtered = filtered.filter(l => l.status    === status);
    if (dept)     filtered = filtered.filter(l => l.department === dept);
    if (search)   filtered = filtered.filter(l =>
        (l.fullName  || '').toLowerCase().includes(search) ||
        (l.email     || '').toLowerCase().includes(search) ||
        (l.studentId || '').toLowerCase().includes(search)
    );
    if (dateFrom) {
        const from = new Date(dateFrom);
        filtered = filtered.filter(l => { const t = l.checkInTimestamp?.toDate(); return t && t >= from; });
    }
    if (dateTo) {
        const to = new Date(dateTo + 'T23:59:59');
        filtered = filtered.filter(l => { const t = l.checkInTimestamp?.toDate(); return t && t <= to; });
    }
    renderAdminLogs(filtered);
}

function renderAdminLogs(logs) {
    const tbody = document.getElementById('admin-logs-body');
    if (logs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="p-8 text-center text-slate-400 italic text-sm">No logs match the current filters.</td></tr>';
        return;
    }

    tbody.innerHTML = '';
    logs.forEach(log => {
        const checkIn = log.checkInTimestamp?.toDate();
        const tr      = document.createElement('tr');
        tr.className  = 'border-b border-slate-100 hover:bg-slate-50 transition';

        const forceOutBtn  = log.status === 'Active'
            ? `<button onclick="adminForceCheckout('${log.id}')" class="block w-full text-center text-[9px] uppercase font-black bg-orange-500 hover:bg-orange-600 text-white px-2 py-1 rounded-lg mb-1 transition">Force Out</button>`
            : '';
        const toggleBanBtn = `<button onclick="adminToggleBlock('${log.uid}')" class="block w-full text-center text-[9px] uppercase font-black bg-red-600 hover:bg-red-700 text-white px-2 py-1 rounded-lg transition">Ban / Unban</button>`;

        tr.innerHTML = `
            <td class="p-3">
                <p class="font-bold text-xs text-[#0a2d5e]">${log.fullName || 'N/A'}</p>
                <p class="text-[9px] text-slate-400 uppercase tracking-wider">${log.userType || 'N/A'}</p>
                ${log.studentId ? `<p class="text-[9px] text-slate-400 font-mono">ID: ${log.studentId}</p>` : ''}
                <p class="text-[9px] text-slate-300 break-all">${log.email || ''}</p>
            </td>
            <td class="p-3 text-xs font-medium text-slate-600">${log.department || 'N/A'}</td>
            <td class="p-3">
                <p class="text-xs font-bold text-slate-700">${checkIn ? checkIn.toLocaleTimeString() : 'N/A'}</p>
                <p class="text-[9px] text-slate-400">${checkIn ? checkIn.toLocaleDateString() : ''}</p>
                <p class="text-[9px] italic text-slate-400">${log.reason || ''}</p>
            </td>
            <td class="p-3">
                <span class="text-[9px] font-black tracking-widest px-2 py-1 uppercase rounded-lg ${log.status === 'Active' ? 'bg-green-100 text-green-700 border border-green-200' : 'bg-slate-100 text-slate-500 border border-slate-200'}">
                    ${log.status}
                </span>
                ${log.autoClosed    ? '<p class="text-[9px] text-orange-500 mt-1">Auto-closed</p>'     : ''}
                ${log.forcedByAdmin ? '<p class="text-[9px] text-red-500 mt-1">Force checkout</p>'     : ''}
            </td>
            <td class="p-3 align-middle min-w-[90px]">${forceOutBtn}${toggleBanBtn}</td>
        `;
        tbody.appendChild(tr);
    });
}


// ─── ADMIN ACTIONS ────────────────────────────────────────────────────────────

window.adminForceCheckout = async (logId) => {
    if (!confirm('Force check out this user? This will end their active session.')) return;
    try {
        await updateDoc(doc(db, 'logs', logId), {
            status: 'Completed',
            checkOutTimestamp: serverTimestamp(),
            forcedByAdmin: true
        });
        showToast('Success', 'User manually checked out.', 'success');
        // onSnapshot auto-refreshes the table
    } catch (e) {
        console.error(e);
        showToast('Error', 'Failed to force checkout.', 'error');
    }
};

// Ban/unban toggle — checks live user status before acting
window.adminToggleBlock = async (uid) => {
    try {
        const userRef = doc(db, 'users', uid);
        const userDoc = await getDoc(userRef);
        if (!userDoc.exists()) return showToast('Error', 'User not found in database.', 'error');

        const isBlocked = userDoc.data()?.isBlocked === true;
        const name      = userDoc.data()?.fullName  || 'this user';

        if (isBlocked) {
            if (!confirm(`Reinstate access for ${name}? They will be able to log in again.`)) return;
            await updateDoc(userRef, { isBlocked: false });
            showToast('Success', `${name}'s access has been reinstated.`, 'success');
        } else {
            if (!confirm(`SUSPEND ${name}'s account? They will be locked out immediately.`)) return;
            await updateDoc(userRef, { isBlocked: true });
            showToast('Success', `${name}'s account has been suspended.`, 'success');
        }
    } catch (e) {
        console.error(e);
        showToast('Error', 'Failed to update user status.', 'error');
    }
};


// ─── ADMIN BOOK MANAGEMENT ────────────────────────────────────────────────────

document.getElementById('issueBookBtn').onclick = async () => {
    const email      = document.getElementById('bookUserEmail').value.trim();
    const title      = document.getElementById('bookTitleInput').value.trim();
    const dueDateStr = document.getElementById('bookDueDate').value;
    const btn        = document.getElementById('issueBookBtn');

    if (!email || !title || !dueDateStr) return showToast('Error', 'Please fill all fields.', 'warning');

    // Use noon to avoid timezone off-by-one-day issues
    const dueDate = new Date(dueDateStr + 'T12:00:00');
    const today   = new Date(); today.setHours(0, 0, 0, 0);
    if (dueDate < today) return showToast('Error', 'Due date cannot be in the past.', 'warning');

    btn.disabled  = true;
    btn.innerText = 'Processing...';

    try {
        const uq   = query(collection(db, 'users'), where('email', '==', email));
        const uSnap = await getDocs(uq);
        if (uSnap.empty) {
            showToast('Error', 'No registered user found with that email.', 'error');
            return;
        }

        await addDoc(collection(db, 'borrowed_books'), {
            uid:        uSnap.docs[0].id,
            userEmail:  email,
            bookTitle:  title,
            borrowDate: serverTimestamp(),
            dueDate:    dueDate,
            status:     'Borrowed'
        });

        showToast('Success', 'Book successfully assigned to user.', 'success');
        document.getElementById('bookUserEmail').value = '';
        document.getElementById('bookTitleInput').value = '';
        document.getElementById('bookDueDate').value    = '';
        await loadAdminBooks();

    } catch (e) {
        console.error(e);
        showToast('Error', 'Failed to issue book.', 'error');
    } finally {
        btn.disabled  = false;
        btn.innerText = 'Assign Book';
    }
};

async function loadAdminBooks() {
    try {
        const q    = query(collection(db, 'borrowed_books'), where('status', '==', 'Borrowed'));
        const snap = await getDocs(q);
        const tbody = document.getElementById('admin-books-body');

        if (snap.empty) {
            tbody.innerHTML = '<tr><td colspan="3" class="p-4 text-center text-xs text-slate-400">No active borrowed books.</td></tr>';
            return;
        }

        const now   = new Date();
        const books = [];
        snap.forEach(d => books.push({ id: d.id, ...d.data() }));
        // Sort overdue first, then by due date ascending
        books.sort((a, b) => {
            const dA = a.dueDate ? a.dueDate.toDate() : new Date(9999, 0);
            const dB = b.dueDate ? b.dueDate.toDate() : new Date(9999, 0);
            return dA - dB;
        });

        let html = '';
        books.forEach(b => {
            if (!b.dueDate) return; // null guard
            const due       = b.dueDate.toDate();
            const isOverdue = due < now;
            html += `
                <tr class="border-b ${isOverdue ? 'bg-red-50' : ''}">
                    <td class="p-2 text-[9px] break-all max-w-[90px]">${b.userEmail || 'N/A'}</td>
                    <td class="p-2">
                        <p class="text-xs font-bold text-[#0a2d5e]">${b.bookTitle || 'N/A'}</p>
                        <p class="text-[9px] ${isOverdue ? 'text-red-600 font-bold' : 'text-slate-400'}">Due: ${due.toLocaleDateString()}${isOverdue ? ' ⚠' : ''}</p>
                    </td>
                    <td class="p-2">
                        <button onclick="adminReturnBook('${b.id}')" class="bg-green-600 hover:bg-green-700 text-white text-[9px] font-black px-2 py-1 rounded-lg shadow transition">Return</button>
                    </td>
                </tr>`;
        });
        tbody.innerHTML = html;
    } catch (e) {
        console.error('loadAdminBooks error:', e);
    }
}

window.adminReturnBook = async (bookId) => {
    try {
        await updateDoc(doc(db, 'borrowed_books', bookId), { status: 'Returned' });
        showToast('Success', 'Book marked as returned.', 'success');
        await loadAdminBooks();
    } catch (e) {
        showToast('Error', 'Failed to return book.', 'error');
    }
};


// ─── FILTER LISTENERS ─────────────────────────────────────────────────────────

document.getElementById('filterStatus').onchange  = applyAdminFilters;
document.getElementById('filterDept').onchange    = applyAdminFilters;
document.getElementById('adminSearch').oninput    = applyAdminFilters;
document.getElementById('filterDateFrom').onchange = applyAdminFilters;
document.getElementById('filterDateTo').onchange  = applyAdminFilters;

document.getElementById('clearFiltersBtn').onclick = () => {
    document.getElementById('filterStatus').value   = '';
    document.getElementById('filterDept').value     = '';
    document.getElementById('adminSearch').value    = '';
    document.getElementById('filterDateFrom').value = '';
    document.getElementById('filterDateTo').value   = '';
    applyAdminFilters();
};


// ─── LOGIN ────────────────────────────────────────────────────────────────────

document.getElementById('loginBtn').onclick = async () => {
    const btn     = document.getElementById('loginBtn');
    const btnText = document.getElementById('loginBtnText');

    // Show loading state so the user knows something is happening
    btn.disabled       = true;
    btnText.textContent = 'Opening Google...';

    try {
        await signInWithPopup(auth, provider);
        // On success, onAuthStateChanged handles the rest.
        // We do NOT reset the button here — the page will transition away.
    } catch (error) {
        // Reset button on any failure, including popup close
        btn.disabled        = false;
        btnText.textContent = 'Sign in with Google';
        if (error.code !== 'auth/popup-closed-by-user') {
            showToast('Login Failed', error.message, 'error');
        }
    }
};


// ─── ONBOARDING ───────────────────────────────────────────────────────────────

function checkOnboardingSaveReady() {
    const idValue  = document.getElementById('studentIdInput').value.trim();
    const idReady  = selectedType === 'visitor' ||
                     selectedType === 'faculty'  ||
                     selectedType === 'employee' ||
                     (selectedType === 'student' && idValue.length > 0);
    const deptReady = selectedType === 'visitor' || selectedDept !== '';
    const ready     = selectedType !== '' && deptReady && idReady;

    const saveBtn = document.getElementById('saveProfileBtn');
    saveBtn.disabled = !ready;
    saveBtn.classList.toggle('opacity-40',          !ready);
    saveBtn.classList.toggle('cursor-not-allowed',  !ready);
}

document.querySelectorAll('.type-btn, .dept-btn').forEach(btn => {
    btn.onclick = () => {
        const isType = btn.classList.contains('type-btn');
        document.querySelectorAll(isType ? '.type-btn' : '.dept-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');

        if (isType) {
            selectedType = btn.dataset.type;

            const deptSection    = document.getElementById('deptSection');
            const studentIdField = document.getElementById('studentIdField');
            const idLabel        = document.getElementById('studentIdLabel');
            const idHint         = document.getElementById('studentIdHint');
            const idInput        = document.getElementById('studentIdInput');

            if (selectedType === 'visitor') {
                deptSection.classList.add('hidden');
                selectedDept = 'N/A';
                studentIdField.classList.remove('hidden');
                idLabel.textContent = 'Visitor / Guest Pass No. (Optional)';
                idHint.textContent  = 'Leave blank if you have no pass number.';
                idInput.required    = false;
            } else {
                deptSection.classList.remove('hidden');
                selectedDept = '';
                document.querySelectorAll('.dept-btn').forEach(b => b.classList.remove('selected'));
                studentIdField.classList.remove('hidden');

                if (selectedType === 'student') {
                    idLabel.textContent = 'Student ID Number *';
                    idHint.textContent  = 'Required — found on your school ID card.';
                    idInput.required    = true;
                } else {
                    idLabel.textContent = 'Employee / Faculty ID (Optional)';
                    idHint.textContent  = '';
                    idInput.required    = false;
                }
            }
        } else {
            selectedDept = btn.dataset.dept;
        }

        checkOnboardingSaveReady();
    };
});

document.getElementById('studentIdInput').oninput = checkOnboardingSaveReady;

document.getElementById('saveProfileBtn').onclick = async () => {
    const studentId = document.getElementById('studentIdInput').value.trim();
    const saveBtn   = document.getElementById('saveProfileBtn');

    if (!selectedType)                               return showToast('Validation', 'Please select your user type.',  'warning');
    if (selectedType !== 'visitor' && !selectedDept) return showToast('Validation', 'Please select your department.', 'warning');
    if (selectedType === 'student' && !studentId)    return showToast('Validation', 'Student ID is required.',        'warning');

    // Disable immediately — prevents double-tap writing two documents
    saveBtn.disabled = true;
    saveBtn.classList.add('opacity-40', 'cursor-not-allowed');
    toggleLoading(true);

    // Use the captured module-level currentUser — auth.currentUser can go null
    // mid-async during token refresh or a brief network drop
    const safeUser = currentUser;
    if (!safeUser) {
        toggleLoading(false);
        saveBtn.disabled = false;
        saveBtn.classList.remove('opacity-40', 'cursor-not-allowed');
        return showToast('Error', 'Session expired. Please sign in again.', 'error');
    }

    try {
        const userRef     = doc(db, 'users', safeUser.uid);
        const existingDoc = await getDoc(userRef);
        // CRITICAL: Never blindly overwrite the role field.
        // An admin manually promoted via Firebase console would lose their role
        // if this defaulted to 'user'. Always read-before-write.
        const existingRole = existingDoc.exists() ? (existingDoc.data().role || 'user') : 'user';

        await setDoc(userRef, {
            uid:                 safeUser.uid,
            email:               safeUser.email,
            fullName:            safeUser.displayName || 'N/A',
            userType:            selectedType,
            department:          selectedDept || 'N/A',
            studentId:           studentId,
            onboardingCompleted: true,
            role:                existingRole,  // preserved — set to 'admin' ONLY via Firebase console
            isBlocked:           false,
            createdAt:           serverTimestamp()
        }, { merge: true });

        showToast('Success', 'Profile setup complete! Welcome to the NEU Library.', 'success');
        await checkActiveLog(safeUser.uid);
    } catch (error) {
        console.error('saveProfileBtn error:', error);
        showToast('Error', 'Failed to save profile. Please try again.', 'error');
        // Re-enable so the user can retry
        saveBtn.disabled = false;
        saveBtn.classList.remove('opacity-40', 'cursor-not-allowed');
    } finally {
        toggleLoading(false);
    }
};


// ─── CHECK-IN REASON BUTTONS ──────────────────────────────────────────────────

document.querySelectorAll('.reason-btn').forEach(btn => {
    btn.onclick = () => {
        document.querySelectorAll('.reason-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        selectedReason = btn.dataset.reason;
        document.getElementById('customReason').classList.toggle('hidden', selectedReason !== 'Others');
        document.getElementById('confirmCheckIn').classList.remove('hidden');
    };
});
