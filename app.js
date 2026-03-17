import { auth, db, provider } from './firebase-config.js';
import { onAuthStateChanged, signInWithPopup, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
    doc, getDoc, setDoc, updateDoc, deleteDoc,
    collection, query, where, getDocs, addDoc,
    serverTimestamp, limit, orderBy, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// ─── MODULE-LEVEL STATE ───────────────────────────────────────────────────────
let selectedType      = '';
let selectedDept      = '';
let selectedReason    = '';
let clockInterval     = null;
let countdownInterval = null;
let currentUser       = null;
let currentLogId      = null;
let currentLogData    = null;
let logoutTimer       = null;
let adminUnsubscribe  = null;
let allAdminLogs      = [];
// Tracks where the user was BEFORE opening History, so X closes back to the right view.
// Possible values: 'active-pass-ui' | 'checkin-ui' | 'checkout-success-ui'
let previousView      = 'checkin-ui';
// Cached admin flag — reset to null on every sign-out so it always re-fetches on next login
let cachedIsAdmin     = null;

// ─── SECURITY HELPER ──────────────────────────────────────────────────────────
// Escapes a string for safe insertion into HTML to prevent XSS.
function esc(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}

// ─── UTILITY ──────────────────────────────────────────────────────────────────

function showToast(title, message, type = 'success') {
    const toast  = document.getElementById('toast');
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

    // Nav buttons are ONLY shown while user has an active/pending check-in.
    // checkout-success-ui: user has already left — hide nav so they can't access history.
    // login-ui / blocked-ui / onboarding-ui: not fully in the app yet.
    const showNav = id === 'checkin-ui' || id === 'active-pass-ui';
    document.getElementById('historyBtn').classList.toggle('hidden', !showNav);

    // Admin button follows same rule, but only if they ARE an admin
    if (showNav && cachedIsAdmin) {
        document.getElementById('adminBtn').classList.remove('hidden');
    } else {
        document.getElementById('adminBtn').classList.add('hidden');
    }

    // If admin status is still unknown (first load), check it
    if (showNav && cachedIsAdmin === null && currentUser) {
        checkAdminAccess();
    }

    // Reset check-in UI every time the view is shown
    if (id === 'checkin-ui') {
        selectedReason = '';
        document.querySelectorAll('.reason-btn').forEach(b => b.classList.remove('selected'));
        document.getElementById('customReason').value = '';
        document.getElementById('customReason').classList.add('hidden');
        const confirmBtn = document.getElementById('confirmCheckIn');
        confirmBtn.classList.add('hidden');
        confirmBtn.disabled = false;
        updateCheckinGreeting();
        loadCurrentVisitors();
    }

    // Reset onboarding UI every time shown
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
}

// ─── ADMIN ACCESS ─────────────────────────────────────────────────────────────
// Role is ONLY set by a Firebase console edit — never self-declared.
// Result is cached in cachedIsAdmin to avoid a Firestore read on every navigation.
async function checkAdminAccess() {
    if (!currentUser) return;
    try {
        if (cachedIsAdmin === null) {
            const userDoc = await getDoc(doc(db, 'users', currentUser.uid));
            cachedIsAdmin = userDoc.data()?.role === 'admin';
        }
        document.getElementById('adminBtn').classList.toggle('hidden', !cachedIsAdmin);
    } catch (e) {
        console.error('Admin check error:', e);
    }
}

// ─── LIBRARY STATUS BADGE ─────────────────────────────────────────────────────
function updateLibraryStatus() {
    const badge = document.getElementById('lib-status-badge');
    if (!badge) return;
    const now = new Date(), day = now.getDay(), t = now.getHours() * 100 + now.getMinutes();
    let isOpen = false;
    if (day >= 1 && day <= 5) isOpen = t >= 700 && t < 2000;
    else if (day === 6)       isOpen = t >= 800 && t < 1700;
    badge.classList.remove('hidden', 'bg-green-400', 'bg-red-400', 'text-white');
    badge.classList.add(isOpen ? 'bg-green-400' : 'bg-red-400', 'text-white');
    badge.textContent = isOpen ? '● OPEN' : '● CLOSED';
}

// ─── CHECK-IN GREETING ────────────────────────────────────────────────────────
function updateCheckinGreeting() {
    const el = document.getElementById('checkin-greeting');
    if (!el) return;
    const h = new Date().getHours();
    const greet = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    const firstName = currentUser?.displayName?.split(' ')[0] || 'there';
    el.textContent = `${greet}, ${firstName}! 👋`;
}

// ─── CURRENT VISITORS COUNT ───────────────────────────────────────────────────
async function loadCurrentVisitors() {
    const badge = document.getElementById('current-visitors-badge');
    const count = document.getElementById('current-visitors-count');
    if (!badge || !count) return;
    try {
        const snap = await getDocs(query(collection(db, 'logs'), where('status', '==', 'Active')));
        count.textContent = snap.size;
        badge.classList.remove('hidden');
    } catch (e) { badge.classList.add('hidden'); }
}

// ─── BORROWED BOOKS WIDGET ────────────────────────────────────────────────────
async function loadUserBooks(uid) {
    const containers = [
        document.getElementById('user-books-list-checkin'),
        document.getElementById('user-books-list-active')
    ];
    try {
        const snap = await getDocs(query(
            collection(db, 'borrowed_books'),
            where('uid', '==', uid),
            where('status', '==', 'Borrowed')
        ));
        let html = '';
        if (snap.empty) {
            html = '<p class="text-slate-400 italic text-xs border border-dashed rounded-lg p-3 bg-slate-50">No books currently borrowed.</p>';
        } else {
            const now = new Date();
            snap.forEach(docSnap => {
                const book = docSnap.data();
                if (!book.dueDate) return;
                const due = book.dueDate.toDate(), isOverdue = due < now;
                html += `<div class="p-2.5 border rounded-xl ${isOverdue ? 'bg-red-50 border-red-200' : 'bg-white border-slate-200'} flex justify-between items-center shadow-sm">
                    <div>
                        <p class="font-bold text-xs ${isOverdue ? 'text-red-700' : 'text-[#0a2d5e]'}">${esc(book.bookTitle)}</p>
                        <p class="text-[10px] text-slate-500">Due: ${due.toLocaleDateString()}</p>
                    </div>
                    ${isOverdue ? '<span class="text-[9px] font-black bg-red-600 text-white px-2 py-0.5 rounded-lg uppercase tracking-widest animate-pulse-fast">⚠ Overdue</span>' : ''}
                </div>`;
            });
        }
        containers.forEach(el => { if (el) el.innerHTML = html; });
    } catch (e) { console.error('loadUserBooks error:', e); }
}

// ─── AUTH STATE ROUTER ────────────────────────────────────────────────────────
// KIOSK FIX: Force sign-out first so a cached browser session never bypasses the
// login screen. onAuthStateChanged is attached inside .finally() so it only fires
// AFTER the sign-out completes and the session is fully cleared.
signOut(auth).finally(() => {

onAuthStateChanged(auth, async (user) => {
    if (user) {
        currentUser = user;

        // Reject non-NEU emails immediately with an inline error
        if (!user.email.endsWith('@neu.edu.ph')) {
            const errEl = document.getElementById('login-error-msg');
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

        // Clear stale login error
        const errEl = document.getElementById('login-error-msg');
        if (errEl) errEl.classList.add('hidden');

        // Reset admin cache so a different user on the same browser re-checks
        cachedIsAdmin = null;

        try {
            toggleLoading(true);

            // Check pre-blocked emails BEFORE checking if user is registered
            const blockSnap = await getDocs(query(
                collection(db, 'blocked_emails'),
                where('email', '==', user.email)
            ));
            if (!blockSnap.empty) {
                toggleLoading(false);
                const errEl = document.getElementById('login-error-msg');
                const detailEl = document.getElementById('login-error-detail');
                if (errEl && detailEl) {
                    const reason = blockSnap.docs[0].data().reason;
                    detailEl.textContent = `Your email has been blocked from accessing the library portal.${reason ? ' Reason: ' + reason : ''} Please contact the librarian.`;
                    errEl.classList.remove('hidden');
                }
                const btn = document.getElementById('loginBtn');
                const btnText = document.getElementById('loginBtnText');
                if (btn) btn.disabled = false;
                if (btnText) btnText.textContent = 'Sign in with Google';
                await signOut(auth);
                return;
            }

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
        // Signed out — wipe everything and return to login
        currentUser   = null;
        currentLogId  = null;
        currentLogData = null;
        cachedIsAdmin = null;
        allAdminLogs  = [];
        toggleLoading(false);
        showView('login-ui');
        updateLibraryStatus();
    }
});

}); // end signOut().finally()

setInterval(updateLibraryStatus, 60000);
updateLibraryStatus();

// ─── MIDNIGHT GUARD + ACTIVE LOG ──────────────────────────────────────────────
async function checkActiveLog(uid) {
    toggleLoading(true);
    try {
        // Re-check blocked status — admin could have blocked this user after check-in
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
            if (checkInDate && checkInDate !== new Date().toDateString()) {
                // Stale session from a previous day — auto-close it
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

// ─── LOGIN BUTTON ─────────────────────────────────────────────────────────────
document.getElementById('loginBtn').onclick = async () => {
    const btn     = document.getElementById('loginBtn');
    const btnText = document.getElementById('loginBtnText');
    btn.disabled        = true;
    btnText.textContent = 'Opening Google...';
    try {
        await signInWithPopup(auth, provider);
    } catch (error) {
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
    const idReady  = selectedType === 'visitor' || selectedType === 'faculty' ||
                     selectedType === 'employee' || (selectedType === 'student' && idValue.length > 0);
    const deptReady = selectedType === 'visitor' || selectedDept !== '';
    const ready     = selectedType !== '' && deptReady && idReady;
    const saveBtn   = document.getElementById('saveProfileBtn');
    saveBtn.disabled = !ready;
    saveBtn.classList.toggle('opacity-40',         !ready);
    saveBtn.classList.toggle('cursor-not-allowed', !ready);
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

    // Disable immediately to prevent double-submission
    saveBtn.disabled = true;
    saveBtn.classList.add('opacity-40', 'cursor-not-allowed');
    toggleLoading(true);

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
        // NEVER overwrite role — preserve any manually-promoted admin status
        const existingRole = existingDoc.exists() ? (existingDoc.data().role || 'user') : 'user';

        await setDoc(userRef, {
            uid:                 safeUser.uid,
            email:               safeUser.email,
            fullName:            safeUser.displayName || 'N/A',
            userType:            selectedType,
            department:          selectedDept || 'N/A',
            studentId:           studentId,
            onboardingCompleted: true,
            role:                existingRole,
            isBlocked:           false,
            createdAt:           serverTimestamp()
        }, { merge: true });

        cachedIsAdmin = existingRole === 'admin';
        showToast('Success', 'Profile setup complete! Welcome to the NEU Library.', 'success');
        await checkActiveLog(safeUser.uid);
    } catch (error) {
        console.error('saveProfileBtn error:', error);
        showToast('Error', 'Failed to save profile. Please try again.', 'error');
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

// ─── CHECK-IN CONFIRM ─────────────────────────────────────────────────────────
document.getElementById('confirmCheckIn').onclick = async () => {
    const customText = document.getElementById('customReason').value.trim();
    const confirmBtn = document.getElementById('confirmCheckIn');

    if (!selectedReason)                            return showToast('Validation', 'Please select a reason for your visit.', 'warning');
    if (selectedReason === 'Others' && !customText) return showToast('Validation', 'Please specify your reason.', 'warning');
    if (customText.length > 100)                    return showToast('Validation', 'Reason is too long (max 100 characters).', 'warning');

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
            uid:              currentUser.uid,
            email:            currentUser.email,
            fullName:         userData.fullName   || 'N/A',
            userType:         userData.userType   || 'N/A',
            department:       userData.department || 'N/A',
            studentId:        userData.studentId  || '',
            reason:           selectedReason === 'Others' ? customText : selectedReason,
            checkInTimestamp: serverTimestamp(),
            status:           'Active',
            autoClosed:       false
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
function startClock(elementId, checkInTime) {
    if (clockInterval) clearInterval(clockInterval);
    clockInterval = setInterval(() => {
        const now     = new Date();
        const clockEl = document.getElementById(elementId);
        const dateEl  = document.getElementById('live-date');
        const elapsedEl = document.getElementById('pass-elapsed');
        if (clockEl) clockEl.innerText = now.toLocaleTimeString();
        if (dateEl)  dateEl.innerText  = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        if (elapsedEl && checkInTime) {
            const elapsed = Math.floor((now - checkInTime) / 1000);
            const h = Math.floor(elapsed / 3600), m = Math.floor((elapsed % 3600) / 60), s = elapsed % 60;
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
    startClock('live-clock', checkInTime);
    document.getElementById('checkoutBtn').onclick = () => handleCheckout(logId, checkInTime);
    showView('active-pass-ui');
}

// ─── CHECKOUT ─────────────────────────────────────────────────────────────────
async function handleCheckout(logId, checkInTime) {
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

        const durationMs = checkInTime ? (now - checkInTime) : 0;
        const totalMins  = Math.floor(durationMs / 60000);
        const hours      = Math.floor(totalMins / 60);
        const minutes    = totalMins % 60;

        document.getElementById('entry-time').innerText      = checkInTime ? checkInTime.toLocaleTimeString() : 'N/A';
        document.getElementById('exit-time').innerText       = now.toLocaleTimeString();
        document.getElementById('duration-display').innerText = hours > 0 ? `${hours}h ${minutes}m` : `${totalMins} minute${totalMins !== 1 ? 's' : ''}`;

        currentLogId   = null;
        currentLogData = null;

        toggleLoading(false);
        showView('checkout-success-ui'); // Nav buttons are hidden inside showView for this screen

        // Countdown to auto-logout
        let countdown = 15;
        const cdEl    = document.getElementById('logout-countdown');
        if (cdEl) cdEl.innerText = countdown;
        if (countdownInterval) clearInterval(countdownInterval);
        countdownInterval = setInterval(() => {
            countdown--;
            if (cdEl) cdEl.innerText = countdown;
            if (countdown <= 0) { clearInterval(countdownInterval); countdownInterval = null; }
        }, 1000);

        if (logoutTimer) clearTimeout(logoutTimer);
        logoutTimer = setTimeout(async () => {
            if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
            await performLogout();
        }, 15000);

    } catch (error) {
        console.error('Checkout error:', error);
        showToast('Error', 'Failed to check out. Please try again.', 'error');
        checkoutBtn.disabled = false;
        toggleLoading(false);
    }
}

async function performLogout() {
    if (logoutTimer)       { clearTimeout(logoutTimer);        logoutTimer       = null; }
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
    if (clockInterval)     { clearInterval(clockInterval);     clockInterval     = null; }
    if (adminUnsubscribe)  { adminUnsubscribe();                adminUnsubscribe  = null; }

    currentUser    = null;
    currentLogId   = null;
    currentLogData = null;
    cachedIsAdmin  = null;
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
    // Remember where we came from so X returns to the right screen
    previousView = currentLogId ? 'active-pass-ui' : 'checkin-ui';
    showView('history-ui');
    await loadHistory();
};

document.getElementById('closeHistoryBtn').onclick = () => {
    showView(previousView);
};

async function loadHistory() {
    const historyList     = document.getElementById('history-list');
    const bookHistoryList = document.getElementById('book-history-list');
    historyList.innerHTML     = '<p class="text-center text-slate-400 py-4 text-sm">Loading visits...</p>';
    bookHistoryList.innerHTML = '<p class="text-center text-slate-400 py-4 text-sm">Loading books...</p>';

    try {
        const snapLogs = await getDocs(query(
            collection(db, 'logs'),
            where('uid', '==', currentUser.uid),
            limit(50)
        ));

        if (snapLogs.empty) {
            historyList.innerHTML = '<p class="text-center text-slate-400 py-4 text-sm italic">No library visits recorded yet.</p>';
        } else {
            const logs = [];
            snapLogs.forEach(d => logs.push({ id: d.id, ...d.data() }));
            logs.sort((a, b) => (b.checkInTimestamp?.toDate() || 0) - (a.checkInTimestamp?.toDate() || 0));
            historyList.innerHTML = '';
            logs.forEach(log => {
                const checkIn  = log.checkInTimestamp?.toDate();
                const checkOut = log.checkOutTimestamp?.toDate();
                const card = document.createElement('div');
                card.className = `p-3 border rounded-xl bg-white shadow-sm ${log.status === 'Active' ? 'border-l-4 border-green-400' : 'border-slate-200'}`;
                card.innerHTML = `
                    <div class="flex justify-between items-start mb-1">
                        <p class="font-bold text-sm text-[#0a2d5e]">${esc(log.reason)}</p>
                        <span class="text-[9px] font-black px-2 py-1 uppercase rounded-lg ${log.status === 'Active' ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}">${esc(log.status)}</span>
                    </div>
                    <p class="text-xs text-slate-600 font-medium">In: ${checkIn ? checkIn.toLocaleString() : 'N/A'}</p>
                    ${checkOut ? `<p class="text-xs text-slate-500">Out: ${checkOut.toLocaleString()}</p>` : ''}
                    ${log.autoClosed    ? '<p class="text-[10px] text-orange-600 font-bold mt-1">⚠ Auto-closed at midnight</p>' : ''}
                    ${log.forcedByAdmin ? '<p class="text-[10px] text-red-600 font-bold mt-1">⚠ Forced checkout by Admin</p>'   : ''}
                `;
                historyList.appendChild(card);
            });
        }

        const snapBooks = await getDocs(query(
            collection(db, 'borrowed_books'),
            where('uid', '==', currentUser.uid)
        ));

        if (snapBooks.empty) {
            bookHistoryList.innerHTML = '<p class="text-center text-slate-400 py-4 text-sm italic">No borrowed books history.</p>';
        } else {
            const books = [];
            snapBooks.forEach(d => books.push({ id: d.id, ...d.data() }));
            books.sort((a, b) => (b.borrowDate?.toDate?.() || 0) - (a.borrowDate?.toDate?.() || 0));
            bookHistoryList.innerHTML = '';
            const now = new Date();
            books.forEach(book => {
                const borrowDate = book.borrowDate?.toDate?.();
                const due        = book.dueDate ? book.dueDate.toDate() : null;
                const isOverdue  = book.status === 'Borrowed' && due && due < now;
                const card = document.createElement('div');
                card.className = `p-3 border rounded-xl bg-white shadow-sm ${isOverdue ? 'border-l-4 border-red-400' : 'border-slate-200'}`;
                card.innerHTML = `
                    <div class="flex justify-between items-start mb-1">
                        <p class="font-bold text-sm ${isOverdue ? 'text-red-700' : 'text-[#0a2d5e]'}">${esc(book.bookTitle)}</p>
                        <span class="text-[9px] font-black px-2 py-1 uppercase rounded-lg ${book.status === 'Borrowed' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-500'}">${esc(book.status)}</span>
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
function getTodayStr() { return new Date().toISOString().slice(0, 10); }

document.getElementById('exportHistoryBtn').onclick = async () => {
    try {
        toggleLoading(true);
        const snap = await getDocs(query(collection(db, 'logs'), where('uid', '==', currentUser.uid), limit(500)));
        const logs = [];
        snap.forEach(d => logs.push(d.data()));
        logs.sort((a, b) => (b.checkInTimestamp?.toDate() || 0) - (a.checkInTimestamp?.toDate() || 0));
        const rows = [['Date', 'Check-in', 'Check-out', 'Duration (min)', 'Reason', 'Status', 'Auto-closed', 'Force-checkout']];
        logs.forEach(log => {
            const ci = log.checkInTimestamp?.toDate(), co = log.checkOutTimestamp?.toDate();
            const mins = (ci && co) ? Math.floor((co - ci) / 60000) : '';
            rows.push([ci ? ci.toLocaleDateString() : 'N/A', ci ? ci.toLocaleTimeString() : 'N/A',
                co ? co.toLocaleTimeString() : 'N/A', mins,
                `"${(log.reason || '').replace(/"/g, '""')}"`, log.status || '',
                log.autoClosed ? 'Yes' : 'No', log.forcedByAdmin ? 'Yes' : 'No']);
        });
        downloadCSV(rows, `my_library_history_${getTodayStr()}.csv`);
    } catch (e) {
        showToast('Error', 'Failed to export history.', 'error');
    } finally {
        toggleLoading(false);
    }
};

// ─── ADMIN PANEL ──────────────────────────────────────────────────────────────

// Tab switching
document.querySelectorAll('.admin-tab-btn').forEach(btn => {
    btn.onclick = () => {
        // Update tab button styles
        document.querySelectorAll('.admin-tab-btn').forEach(b => {
            b.classList.remove('border-[#0a2d5e]', 'text-[#0a2d5e]');
            b.classList.add('border-transparent', 'text-slate-400');
        });
        btn.classList.add('border-[#0a2d5e]', 'text-[#0a2d5e]');
        btn.classList.remove('border-transparent', 'text-slate-400');

        // Show correct pane
        document.querySelectorAll('.admin-pane').forEach(p => p.classList.add('hidden'));
        document.getElementById(`adminPane-${btn.dataset.tab}`).classList.remove('hidden');

        // Load data for newly active tab
        if (btn.dataset.tab === 'books')   loadAdminBooks();
        if (btn.dataset.tab === 'blocked') loadBlockedTab();
    };
});

document.getElementById('adminBtn').onclick = async () => {
    showView('admin-ui');
    subscribeAdminLogs();
};

document.getElementById('closeAdminBtn').onclick = () => {
    if (adminUnsubscribe) { adminUnsubscribe(); adminUnsubscribe = null; }
    showView(currentLogId ? 'active-pass-ui' : 'checkin-ui');
};

// ─── ADMIN LOGS TAB ───────────────────────────────────────────────────────────
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
        showToast('Error', 'Live data connection lost.', 'error');
    });
}

function updateAdminStats() {
    const today = new Date().toDateString();
    document.getElementById('stat-active').innerText = allAdminLogs.filter(l => l.status === 'Active').length;
    document.getElementById('stat-today').innerText  = allAdminLogs.filter(l => l.checkInTimestamp?.toDate().toDateString() === today).length;
    document.getElementById('stat-total').innerText  = allAdminLogs.length;
}

function applyAdminFilters() {
    const status   = document.getElementById('filterStatus').value;
    const dept     = document.getElementById('filterDept').value;
    const search   = document.getElementById('adminSearch').value.trim().toLowerCase();
    const dateFrom = document.getElementById('filterDateFrom').value;
    const dateTo   = document.getElementById('filterDateTo').value;

    let filtered = [...allAdminLogs];
    if (status)   filtered = filtered.filter(l => l.status     === status);
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
        const tr = document.createElement('tr');
        tr.className = 'border-b border-slate-100 hover:bg-slate-50 transition';
        const forceOutBtn = log.status === 'Active'
            ? `<button onclick="adminForceCheckout('${esc(log.id)}')" class="block w-full text-center text-[9px] uppercase font-black bg-orange-500 hover:bg-orange-600 text-white px-2 py-1 rounded-lg mb-1 transition">Force Out</button>`
            : '';
        const banLabel = log.isBlocked ? 'Unban' : 'Ban';
        tr.innerHTML = `
            <td class="p-3">
                <p class="font-bold text-xs text-[#0a2d5e]">${esc(log.fullName)}</p>
                <p class="text-[9px] text-slate-400 uppercase tracking-wider">${esc(log.userType)}</p>
                ${log.studentId ? `<p class="text-[9px] text-slate-400 font-mono">ID: ${esc(log.studentId)}</p>` : ''}
                <p class="text-[9px] text-slate-300 break-all">${esc(log.email)}</p>
            </td>
            <td class="p-3 text-xs font-medium text-slate-600">${esc(log.department)}</td>
            <td class="p-3">
                <p class="text-xs font-bold text-slate-700">${checkIn ? checkIn.toLocaleTimeString() : 'N/A'}</p>
                <p class="text-[9px] text-slate-400">${checkIn ? checkIn.toLocaleDateString() : ''}</p>
                <p class="text-[9px] italic text-slate-400">${esc(log.reason)}</p>
            </td>
            <td class="p-3">
                <span class="text-[9px] font-black tracking-widest px-2 py-1 uppercase rounded-lg ${log.status === 'Active' ? 'bg-green-100 text-green-700 border border-green-200' : 'bg-slate-100 text-slate-500 border border-slate-200'}">
                    ${esc(log.status)}
                </span>
                ${log.autoClosed    ? '<p class="text-[9px] text-orange-500 mt-1">Auto-closed</p>' : ''}
                ${log.forcedByAdmin ? '<p class="text-[9px] text-red-500 mt-1">Force checkout</p>' : ''}
            </td>
            <td class="p-3 align-middle min-w-[90px]">
                ${forceOutBtn}
                <button onclick="adminToggleBlock('${esc(log.uid)}')" class="block w-full text-center text-[9px] uppercase font-black bg-red-600 hover:bg-red-700 text-white px-2 py-1 rounded-lg transition">${banLabel}</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

document.getElementById('filterStatus').onchange   = applyAdminFilters;
document.getElementById('filterDept').onchange     = applyAdminFilters;
document.getElementById('adminSearch').oninput     = applyAdminFilters;
document.getElementById('filterDateFrom').onchange = applyAdminFilters;
document.getElementById('filterDateTo').onchange   = applyAdminFilters;
document.getElementById('clearFiltersBtn').onclick = () => {
    ['filterStatus','filterDept','adminSearch','filterDateFrom','filterDateTo']
        .forEach(id => { document.getElementById(id).value = ''; });
    applyAdminFilters();
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
        if (status)   filtered = filtered.filter(l => l.status === status);
        if (dept)     filtered = filtered.filter(l => l.department === dept);
        if (search)   filtered = filtered.filter(l =>
            (l.fullName || '').toLowerCase().includes(search) ||
            (l.email    || '').toLowerCase().includes(search) ||
            (l.studentId|| '').toLowerCase().includes(search));
        if (dateFrom) { const from = new Date(dateFrom); filtered = filtered.filter(l => { const t = l.checkInTimestamp?.toDate(); return t && t >= from; }); }
        if (dateTo)   { const to = new Date(dateTo + 'T23:59:59'); filtered = filtered.filter(l => { const t = l.checkInTimestamp?.toDate(); return t && t <= to; }); }
        const rows = [['Name','ID','Email','Type','Department','Date','Check-in','Check-out','Duration (min)','Reason','Status','Auto-closed','Force-checkout']];
        filtered.forEach(log => {
            const ci = log.checkInTimestamp?.toDate(), co = log.checkOutTimestamp?.toDate();
            const mins = (ci && co) ? Math.floor((co - ci) / 60000) : '';
            rows.push([`"${(log.fullName||'').replace(/"/g,'""')}"`,log.studentId||'',log.email||'',
                log.userType||'',log.department||'',
                ci ? ci.toLocaleDateString() : 'N/A', ci ? ci.toLocaleTimeString() : 'N/A',
                co ? co.toLocaleTimeString() : 'N/A', mins,
                `"${(log.reason||'').replace(/"/g,'""')}"`,log.status||'',
                log.autoClosed ? 'Yes':'No', log.forcedByAdmin ? 'Yes':'No']);
        });
        downloadCSV(rows, `library_admin_logs_${getTodayStr()}.csv`);
    } catch (e) {
        showToast('Error', 'Failed to export admin logs.', 'error');
    } finally {
        toggleLoading(false);
    }
};

// ─── ADMIN ACTIONS (logs tab) ─────────────────────────────────────────────────
window.adminForceCheckout = async (logId) => {
    if (!confirm('Force check out this user? This will end their active session.')) return;
    try {
        await updateDoc(doc(db, 'logs', logId), {
            status: 'Completed',
            checkOutTimestamp: serverTimestamp(),
            forcedByAdmin: true
        });
        showToast('Success', 'User manually checked out.', 'success');
    } catch (e) {
        showToast('Error', 'Failed to force checkout.', 'error');
    }
};

window.adminToggleBlock = async (uid) => {
    try {
        const userRef = doc(db, 'users', uid);
        const userDoc = await getDoc(userRef);
        if (!userDoc.exists()) return showToast('Error', 'User not found.', 'error');
        const isBlocked = userDoc.data()?.isBlocked === true;
        const name      = userDoc.data()?.fullName  || 'this user';
        if (isBlocked) {
            if (!confirm(`Reinstate access for ${name}?`)) return;
            await updateDoc(userRef, { isBlocked: false });
            showToast('Success', `${name}'s access reinstated.`, 'success');
        } else {
            if (!confirm(`SUSPEND ${name}'s account? They will be locked out immediately.`)) return;
            await updateDoc(userRef, { isBlocked: true });
            showToast('Success', `${name}'s account suspended.`, 'success');
        }
        // Refresh blocked tab if it's open
        loadBlockedTab();
    } catch (e) {
        showToast('Error', 'Failed to update user status.', 'error');
    }
};

// ─── ADMIN USERS TAB ──────────────────────────────────────────────────────────
document.getElementById('loadUsersBtn').onclick = loadAdminUsers;
document.getElementById('userSearch').onkeydown = e => { if (e.key === 'Enter') loadAdminUsers(); };

async function loadAdminUsers() {
    const tbody      = document.getElementById('admin-users-body');
    const searchTerm = document.getElementById('userSearch').value.trim().toLowerCase();
    const typeFilter = document.getElementById('userTypeFilter').value;
    const roleFilter = document.getElementById('userRoleFilter').value;

    tbody.innerHTML = '<tr><td colspan="5" class="p-8 text-center text-slate-400 italic text-sm">Loading users...</td></tr>';

    try {
        // Fetch up to 200 users — client-side filter for flexibility (no composite index)
        const snap = await getDocs(query(collection(db, 'users'), limit(200)));
        let users = [];
        snap.forEach(d => users.push({ id: d.id, ...d.data() }));

        if (searchTerm) users = users.filter(u =>
            (u.fullName  || '').toLowerCase().includes(searchTerm) ||
            (u.email     || '').toLowerCase().includes(searchTerm) ||
            (u.studentId || '').toLowerCase().includes(searchTerm)
        );
        if (typeFilter) users = users.filter(u => u.userType === typeFilter);
        if (roleFilter) users = users.filter(u => (u.role || 'user') === roleFilter);

        if (users.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="p-8 text-center text-slate-400 italic text-sm">No users found.</td></tr>';
            return;
        }

        users.sort((a, b) => (a.fullName || '').localeCompare(b.fullName || ''));
        tbody.innerHTML = '';
        users.forEach(u => {
            const tr = document.createElement('tr');
            tr.className = 'border-b border-slate-100 hover:bg-slate-50 transition';
            const isAdmin   = u.role === 'admin';
            const isBlocked = u.isBlocked === true;

            tr.innerHTML = `
                <td class="p-3">
                    <p class="font-bold text-xs text-[#0a2d5e]">${esc(u.fullName)}</p>
                    <p class="text-[9px] text-slate-400 break-all">${esc(u.email)}</p>
                    ${u.studentId ? `<p class="text-[9px] font-mono text-slate-400">ID: ${esc(u.studentId)}</p>` : ''}
                </td>
                <td class="p-3">
                    <span class="text-[9px] font-black px-2 py-0.5 rounded-lg bg-blue-50 text-blue-700 uppercase">${esc(u.userType || 'N/A')}</span>
                    <p class="text-[9px] text-slate-400 mt-1">${esc(u.department || 'N/A')}</p>
                </td>
                <td class="p-3">
                    <span class="text-[9px] font-black px-2 py-0.5 rounded-lg uppercase ${isAdmin ? 'bg-purple-100 text-purple-700' : 'bg-slate-100 text-slate-500'}">${isAdmin ? 'Admin' : 'User'}</span>
                </td>
                <td class="p-3">
                    <span class="text-[9px] font-black px-2 py-0.5 rounded-lg uppercase ${isBlocked ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}">${isBlocked ? 'Suspended' : 'Active'}</span>
                </td>
                <td class="p-3 space-y-1 min-w-[110px]">
                    <button onclick="adminChangeRole('${esc(u.id)}','${esc(u.fullName)}','${esc(u.role || 'user')}')"
                        class="block w-full text-center text-[9px] uppercase font-black px-2 py-1 rounded-lg transition ${isAdmin ? 'bg-slate-500 hover:bg-slate-600' : 'bg-purple-600 hover:bg-purple-700'} text-white">
                        ${isAdmin ? 'Demote' : 'Make Admin'}
                    </button>
                    <button onclick="adminChangeUserType('${esc(u.id)}','${esc(u.fullName)}')"
                        class="block w-full text-center text-[9px] uppercase font-black bg-blue-600 hover:bg-blue-700 text-white px-2 py-1 rounded-lg transition">
                        Change Type
                    </button>
                    <button onclick="adminToggleBlock('${esc(u.id)}')"
                        class="block w-full text-center text-[9px] uppercase font-black px-2 py-1 rounded-lg transition ${isBlocked ? 'bg-green-600 hover:bg-green-700' : 'bg-red-600 hover:bg-red-700'} text-white">
                        ${isBlocked ? 'Unban' : 'Ban'}
                    </button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    } catch (e) {
        console.error('loadAdminUsers error:', e);
        showToast('Error', 'Failed to load users.', 'error');
    }
}

window.adminChangeRole = async (uid, name, currentRole) => {
    const newRole = currentRole === 'admin' ? 'user' : 'admin';
    const action  = newRole === 'admin' ? `PROMOTE ${name} to Admin?` : `DEMOTE ${name} back to User?`;
    if (!confirm(action)) return;
    try {
        await updateDoc(doc(db, 'users', uid), { role: newRole });
        showToast('Success', `${name} is now ${newRole === 'admin' ? 'an Admin' : 'a regular User'}.`, 'success');
        await loadAdminUsers(); // refresh table
    } catch (e) {
        showToast('Error', 'Failed to change role.', 'error');
    }
};

window.adminChangeUserType = async (uid, name) => {
    const types = ['student', 'faculty', 'employee', 'visitor'];
    const choice = prompt(`Change user type for ${name}.\nEnter one of: student, faculty, employee, visitor`);
    if (!choice) return;
    const newType = choice.trim().toLowerCase();
    if (!types.includes(newType)) {
        showToast('Validation', `Invalid type. Choose: ${types.join(', ')}`, 'warning');
        return;
    }
    try {
        await updateDoc(doc(db, 'users', uid), { userType: newType });
        showToast('Success', `${name}'s type changed to ${newType}.`, 'success');
        await loadAdminUsers();
    } catch (e) {
        showToast('Error', 'Failed to change user type.', 'error');
    }
};

// ─── ADMIN BOOKS TAB ──────────────────────────────────────────────────────────
document.getElementById('issueBookBtn').onclick = async () => {
    const email      = document.getElementById('bookUserEmail').value.trim();
    const title      = document.getElementById('bookTitleInput').value.trim();
    const dueDateStr = document.getElementById('bookDueDate').value;
    const btn        = document.getElementById('issueBookBtn');

    if (!email || !title || !dueDateStr) return showToast('Error', 'Please fill all fields.', 'warning');
    const dueDate = new Date(dueDateStr + 'T12:00:00');
    const today   = new Date(); today.setHours(0, 0, 0, 0);
    if (dueDate < today) return showToast('Error', 'Due date cannot be in the past.', 'warning');

    btn.disabled  = true;
    btn.innerText = 'Processing...';
    try {
        const uSnap = await getDocs(query(collection(db, 'users'), where('email', '==', email)));
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
        showToast('Error', 'Failed to issue book.', 'error');
    } finally {
        // Always re-enable, even on early return
        btn.disabled  = false;
        btn.innerText = 'Assign Book';
    }
};

async function loadAdminBooks() {
    const tbody = document.getElementById('admin-books-body');
    try {
        const snap = await getDocs(query(collection(db, 'borrowed_books'), where('status', '==', 'Borrowed')));
        if (snap.empty) {
            tbody.innerHTML = '<tr><td colspan="3" class="p-4 text-center text-xs text-slate-400">No active borrowed books.</td></tr>';
            return;
        }
        const now = new Date();
        const books = [];
        snap.forEach(d => books.push({ id: d.id, ...d.data() }));
        books.sort((a, b) => (a.dueDate?.toDate() || new Date(9999,0)) - (b.dueDate?.toDate() || new Date(9999,0)));
        tbody.innerHTML = '';
        books.forEach(b => {
            if (!b.dueDate) return;
            const due = b.dueDate.toDate(), isOverdue = due < now;
            const tr  = document.createElement('tr');
            tr.className = `border-b ${isOverdue ? 'bg-red-50' : ''}`;
            tr.innerHTML = `
                <td class="p-2 text-[9px] break-all max-w-[90px]">${esc(b.userEmail)}</td>
                <td class="p-2">
                    <p class="text-xs font-bold text-[#0a2d5e]">${esc(b.bookTitle)}</p>
                    <p class="text-[9px] ${isOverdue ? 'text-red-600 font-bold' : 'text-slate-400'}">Due: ${due.toLocaleDateString()}${isOverdue ? ' ⚠' : ''}</p>
                </td>
                <td class="p-2">
                    <button onclick="adminReturnBook('${esc(b.id)}')" class="bg-green-600 hover:bg-green-700 text-white text-[9px] font-black px-2 py-1 rounded-lg shadow transition">Return</button>
                </td>
            `;
            tbody.appendChild(tr);
        });
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

// ─── ADMIN BLOCKED TAB ────────────────────────────────────────────────────────
async function loadBlockedTab() {
    await Promise.all([loadPreBlockedEmails(), loadBannedUsers()]);
}

async function loadPreBlockedEmails() {
    const list = document.getElementById('preblock-list');
    list.innerHTML = '<p class="text-xs text-slate-400 italic text-center py-3">Loading...</p>';
    try {
        const snap = await getDocs(collection(db, 'blocked_emails'));
        if (snap.empty) {
            list.innerHTML = '<p class="text-xs text-slate-400 italic text-center py-3">No pre-blocked emails.</p>';
            return;
        }
        list.innerHTML = '';
        snap.forEach(d => {
            const data = d.data();
            const div  = document.createElement('div');
            div.className = 'flex justify-between items-center bg-red-50 border border-red-200 rounded-xl px-3 py-2';
            div.innerHTML = `
                <div>
                    <p class="text-xs font-bold text-red-700">${esc(data.email)}</p>
                    ${data.reason ? `<p class="text-[10px] text-red-500">${esc(data.reason)}</p>` : ''}
                </div>
                <button onclick="removePreBlock('${esc(d.id)}')" class="text-[9px] font-black bg-white border border-red-300 text-red-600 px-2 py-1 rounded-lg hover:bg-red-100 transition flex-shrink-0">Remove</button>
            `;
            list.appendChild(div);
        });
    } catch (e) {
        list.innerHTML = '<p class="text-xs text-red-400 italic text-center py-3">Failed to load.</p>';
    }
}

async function loadBannedUsers() {
    const list = document.getElementById('banned-users-list');
    list.innerHTML = '<p class="text-xs text-slate-400 italic text-center py-3">Loading...</p>';
    try {
        const snap = await getDocs(query(collection(db, 'users'), where('isBlocked', '==', true)));
        if (snap.empty) {
            list.innerHTML = '<p class="text-xs text-slate-400 italic text-center py-3">No suspended users.</p>';
            return;
        }
        list.innerHTML = '';
        snap.forEach(d => {
            const u   = d.data();
            const div = document.createElement('div');
            div.className = 'flex justify-between items-center bg-red-50 border border-red-200 rounded-xl px-3 py-2';
            div.innerHTML = `
                <div>
                    <p class="text-xs font-bold text-red-700">${esc(u.fullName)}</p>
                    <p class="text-[10px] text-red-500">${esc(u.email)} · ${esc(u.userType)}</p>
                </div>
                <button onclick="adminToggleBlock('${esc(d.id)}')" class="text-[9px] font-black bg-green-600 text-white px-2 py-1 rounded-lg hover:bg-green-700 transition flex-shrink-0">Unban</button>
            `;
            list.appendChild(div);
        });
    } catch (e) {
        list.innerHTML = '<p class="text-xs text-red-400 italic text-center py-3">Failed to load.</p>';
    }
}

document.getElementById('preBlockBtn').onclick = async () => {
    const email  = document.getElementById('preBlockEmail').value.trim().toLowerCase();
    const reason = document.getElementById('preBlockReason').value.trim();
    const btn    = document.getElementById('preBlockBtn');

    if (!email) return showToast('Validation', 'Please enter an email address.', 'warning');
    if (!email.endsWith('@neu.edu.ph')) return showToast('Validation', 'Only @neu.edu.ph emails can be blocked here.', 'warning');

    // Check if already blocked
    const existing = await getDocs(query(collection(db, 'blocked_emails'), where('email', '==', email)));
    if (!existing.empty) return showToast('Info', 'This email is already pre-blocked.', 'info');

    btn.disabled  = true;
    btn.innerText = 'Blocking...';
    try {
        await addDoc(collection(db, 'blocked_emails'), {
            email:     email,
            reason:    reason,
            blockedAt: serverTimestamp(),
            blockedBy: currentUser?.email || 'admin'
        });
        // If the user is already registered, also set isBlocked on their user doc
        const userSnap = await getDocs(query(collection(db, 'users'), where('email', '==', email)));
        if (!userSnap.empty) {
            await updateDoc(doc(db, 'users', userSnap.docs[0].id), { isBlocked: true });
        }
        document.getElementById('preBlockEmail').value  = '';
        document.getElementById('preBlockReason').value = '';
        showToast('Success', `${email} has been blocked.`, 'success');
        await loadBlockedTab();
    } catch (e) {
        showToast('Error', 'Failed to block email.', 'error');
    } finally {
        btn.disabled  = false;
        btn.innerText = '🚫 Block Email';
    }
};

window.removePreBlock = async (docId) => {
    if (!confirm('Remove this pre-block? The email will be allowed to log in again.')) return;
    try {
        await deleteDoc(doc(db, 'blocked_emails', docId));
        showToast('Success', 'Pre-block removed.', 'success');
        await loadBlockedTab();
    } catch (e) {
        showToast('Error', 'Failed to remove pre-block.', 'error');
    }
};
