/* Frontend blog serverless — JavaScript vanilla, zero dependențe.
 *
 * Face două lucruri:
 *   1. Login la Cognito prin InitiateAuth => primește un IdToken (JWT)
 *   2. Apelează API Gateway, trimițând token-ul în headerul Authorization
 */

const { API_URL, USER_POOL_CLIENT_ID, REGION } = window.CONFIG;

const authState = {
  view: 'login',
  pendingEmail: '',
};

// ── Starea de autentificare ────────────────────────────────────────────
// Păstrăm token-ul în sessionStorage: dispare la închiderea tab-ului.
// (În producție ai prefera memoria + un refresh token în cookie HttpOnly;
//  sessionStorage e vulnerabil la XSS. Aici e ok pentru un proiect de învățat.)
const store = {
  get token() { return sessionStorage.getItem('idToken'); },
  get email() { return sessionStorage.getItem('email'); },
  save(token, email) {
    sessionStorage.setItem('idToken', token);
    sessionStorage.setItem('email', email);
  },
  clear() { sessionStorage.clear(); },
};

// ── Cognito: autentificare și confirmare fără SDK ──────────────────────
async function cognitoRequest(operation, body) {
  const res = await fetch(`https://cognito-idp.${REGION}.amazonaws.com/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': `AWSCognitoIdentityProviderService.${operation}`,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Cererea către Cognito a eșuat');
  return data;
}

async function login(email, password) {
  // InitiateAuth e o operație PUBLICĂ a Cognito: nu cere semnătură SigV4,
  // deci e apelabilă direct din browser cu un simplu fetch.
  const data = await cognitoRequest('InitiateAuth', {
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: USER_POOL_CLIENT_ID,
    AuthParameters: { USERNAME: email, PASSWORD: password },
  });

  // Dacă userul a fost creat de admin fără `--permanent`, Cognito nu dă tokenuri
  // ci un "challenge": trebuie schimbată parola înainte de primul login.
  if (data.ChallengeName) {
    throw new Error(
      `Cognito cere pasul suplimentar "${data.ChallengeName}". ` +
      'Rulează: aws cognito-idp admin-set-user-password ... --permanent'
    );
  }

  // De ce IdToken și nu AccessToken? Ambele trec de authorizer, dar doar
  // IdToken conține claim-ul `email`, pe care Lambda îl folosește ca `author`.
  return data.AuthenticationResult.IdToken;
}

async function signup(email, password) {
  return cognitoRequest('SignUp', {
    ClientId: USER_POOL_CLIENT_ID,
    Username: email,
    Password: password,
    UserAttributes: [{ Name: 'email', Value: email }],
  });
}

async function confirmSignup(email, code) {
  return cognitoRequest('ConfirmSignUp', {
    ClientId: USER_POOL_CLIENT_ID,
    Username: email,
    ConfirmationCode: code,
  });
}

async function resendConfirmationCode(email) {
  return cognitoRequest('ResendConfirmationCode', {
    ClientId: USER_POOL_CLIENT_ID,
    Username: email,
  });
}

// Decodează payload-ul unui JWT (partea din mijloc, base64url — NU e criptat,
// doar codat). De aici luăm email-ul EXACT cum îl va vedea și Lambda, în loc
// să ne bazăm pe ce a tastat userul (care poate diferi, ex. prin majuscule —
// altfel butonul "Șterge" nu ar apărea la postările proprii).
function jwtPayload(token) {
  const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(base64));
}

// ── Apeluri către API ──────────────────────────────────────────────────
async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };

  // Rutele protejate au nevoie de token. Prefixul "Bearer " e obligatoriu,
  // fiindcă authorizer-ul e configurat cu IdentitySource pe headerul Authorization.
  if (store.token) headers.Authorization = `Bearer ${store.token}`;

  const res = await fetch(`${API_URL}${path}`, { ...options, headers });
  const data = await res.json().catch(() => ({}));

  if (res.status === 401) {
    // Token expirat (60 min) sau lipsă.
    store.clear();
    render();
    throw new Error('Sesiune expirată — autentifică-te din nou');
  }
  if (!res.ok) throw new Error(data.message || `Eroare HTTP ${res.status}`);
  return data;
}

const getPosts    = ()     => api('/posts');                                        // public
const createPost  = (body) => api('/posts', { method: 'POST', body: JSON.stringify(body) });
const deletePost  = (id)   => api(`/posts/${id}`, { method: 'DELETE' });

// ── Upload imagine în S3 prin presigned URL ───────────────────────
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

async function uploadImage(file) {
  if (file.size > MAX_IMAGE_BYTES) throw new Error('Imaginea depășește 5 MB');

  // 1. Cerem un URL semnat (Lambda validează tipul și alege cheia).
  const { uploadUrl, imageKey } = await api('/uploads', {
    method: 'POST',
    body: JSON.stringify({ contentType: file.type }),
  });

  // 2. Urcăm fișierul DIRECT în S3 — nu trece prin API Gateway/Lambda.
  //    Content-Type trebuie să coincidă cu cel semnat, altfel S3 refuză.
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file,
  });
  if (!res.ok) throw new Error(`Upload eșuat (HTTP ${res.status})`);

  return imageKey;
}

// ── UI ─────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

function status(message, kind = 'ok') {
  const el = $('status');
  el.textContent = message;
  el.className = kind;
  if (kind === 'ok') setTimeout(() => (el.className = 'hidden'), 3000);
}

function render() {
  const loggedIn = Boolean(store.token);
  $('loginSection').classList.toggle('hidden', loggedIn || authState.view !== 'login');
  $('signupSection').classList.toggle('hidden', loggedIn || authState.view !== 'signup');
  $('confirmSection').classList.toggle('hidden', loggedIn || authState.view !== 'confirm');
  $('userSection').classList.toggle('hidden', !loggedIn);
  $('createSection').classList.toggle('hidden', !loggedIn);
  $('whoami').textContent = store.email || '';
  $('confirmEmail').textContent = authState.pendingEmail;
}

function showAuthView(view) {
  authState.view = view;
  render();
}

async function loadPosts() {
  try {
    const { posts } = await getPosts();
    $('posts').innerHTML = posts.length
      ? posts.map(postHtml).join('')
      : '<p class="meta">Încă nicio postare.</p>';

    // Butoanele de ștergere se leagă după ce HTML-ul e în DOM.
    document.querySelectorAll('[data-delete]').forEach((btn) => {
      btn.onclick = () => onDelete(btn.dataset.delete);
    });
  } catch (err) {
    status(err.message, 'err');
  }
}

function postHtml(p) {
  // escapeHtml: conținutul vine de la utilizatori, deci nu îl injectăm brut
  // în DOM (altfel = XSS).
  const canDelete = store.email && store.email === p.author;
  return `
    <article>
      <h3>${escapeHtml(p.title)}</h3>
      <p>${escapeHtml(p.content)}</p>
      ${p.imageUrl ? `<img src="${escapeHtml(p.imageUrl)}" alt="" loading="lazy">` : ''}
      <p class="meta">
        de ${escapeHtml(p.author)} · ${new Date(p.createdAt).toLocaleString('ro-RO')}
        ${canDelete ? `<button class="danger" data-delete="${p.postId}">Șterge</button>` : ''}
      </p>
    </article>`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

// ── Handlere de evenimente ─────────────────────────────────────────────
$('loginBtn').onclick = async () => {
  try {
    const token = await login($('email').value.trim(), $('password').value);
    // Email-ul se ia din token, nu din input — e sursa de adevăr a backend-ului.
    store.save(token, jwtPayload(token).email);
    $('password').value = '';
    render();
    status('Autentificat cu succes');
    loadPosts(); // reîncarcă, ca să apară butoanele de ștergere
  } catch (err) {
    status(err.message, 'err');
  }
};

$('showSignupBtn').onclick = () => showAuthView('signup');
$('showLoginBtn').onclick = () => showAuthView('login');

$('signupBtn').onclick = async () => {
  try {
    const email = $('signupEmail').value.trim();
    const password = $('signupPassword').value;
    const passwordConfirmation = $('signupPasswordConfirm').value;

    if (!email || !password || !passwordConfirmation) {
      return status('Completează emailul și ambele câmpuri de parolă', 'err');
    }
    if (password !== passwordConfirmation) {
      return status('Parolele nu se potrivesc', 'err');
    }

    await signup(email, password);
    authState.pendingEmail = email;
    $('signupPassword').value = '';
    $('signupPasswordConfirm').value = '';
    $('confirmCode').value = '';
    showAuthView('confirm');
    status('Verifică emailul pentru codul de confirmare');
  } catch (err) {
    status(err.message, 'err');
  }
};

$('confirmBtn').onclick = async () => {
  try {
    const code = $('confirmCode').value.trim();
    if (!authState.pendingEmail) return status('Înregistrează un cont înainte de confirmare', 'err');
    if (!code) return status('Introdu codul primit pe email', 'err');

    await confirmSignup(authState.pendingEmail, code);
    $('email').value = authState.pendingEmail;
    $('password').value = '';
    authState.pendingEmail = '';
    showAuthView('login');
    status('Cont confirmat. Autentifică-te pentru a continua.');
  } catch (err) {
    status(err.message, 'err');
  }
};

$('resendCodeBtn').onclick = async () => {
  try {
    if (!authState.pendingEmail) return status('Înregistrează un cont înainte de retrimitere', 'err');
    await resendConfirmationCode(authState.pendingEmail);
    status('Am retrimis codul la adresa de email.');
  } catch (err) {
    status(err.message, 'err');
  }
};

$('logoutBtn').onclick = () => {
  store.clear();
  render();
  loadPosts();
};

$('createBtn').onclick = async () => {
  try {
    const title = $('title').value.trim();
    const content = $('content').value.trim();
    if (!title || !content) return status('Completează titlul și conținutul', 'err');

    const file = $('image').files[0];
    let imageKey;
    if (file) {
      status('Se urcă imaginea…');
      imageKey = await uploadImage(file);
    }

    await createPost({ title, content, ...(imageKey && { imageKey }) });
    $('title').value = '';
    $('content').value = '';
    $('image').value = '';
    status('Postare publicată');
    loadPosts();
  } catch (err) {
    status(err.message, 'err');
  }
};

$('refreshBtn').onclick = loadPosts;

// ── Pornire ────────────────────────────────────────────────────────────
async function onDelete(postId) {
  if (!confirm('Ștergi postarea?')) return;
  try {
    await deletePost(postId);
    status('Postare ștearsă');
    loadPosts();
  } catch (err) {
    status(err.message, 'err');
  }
}

render();
loadPosts();
