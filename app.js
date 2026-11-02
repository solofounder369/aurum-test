// Aurum live test (GitHub Pages + Firebase).
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc, getDoc, setDoc, addDoc, updateDoc, onSnapshot, query, where, orderBy, limit } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./config.js";

/* ---------- tiny DOM helper (all user text set via textContent) ---------- */
function h(tag, props, ...kids){
  const e = document.createElement(tag);
  for (const [k,v] of Object.entries(props || {})){
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v; // static, trusted markup only (icons)
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const k of kids.flat()){
    if (k == null || k === false) continue;
    e.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
  return e;
}
const ICON = {
  back:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
  send:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  chats:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/></svg>',
  members:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><circle cx="17" cy="9" r="2.5"/><path d="M3 19c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5M15 14c3 0 6 1.5 6 5"/></svg>',
  card:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 14h5"/></svg>',
  feedback:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l2.5 5.5 6 .6-4.5 4 1.3 6L12 16l-5.3 3.1 1.3-6-4.5-4 6-.6z"/></svg>',
  lock:'<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/></svg>'
};

/* ---------- state ---------- */
const S = {
  me:null, isOwner:false,
  members:{}, membersReady:false, chats:{}, chatsReady:false,
  view:'loading', tab:'chats', chatId:null, msgs:[], msgUnsub:null,
  priority:'whenever', promiseMode:false, knockFor:null,
  myFeedback:null, allFeedback:[], slow:false, unsubs:[]
};
const app = document.getElementById('app');
const CIRCLE = 'circle';
const configured = !String(firebaseConfig.apiKey || '').startsWith('PASTE');
let fb = null, auth = null, db = null;
if (configured){ fb = initializeApp(firebaseConfig); auth = getAuth(fb); db = getFirestore(fb); }

/* ---------- helpers ---------- */
function toast(msg){ const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(t._h); t._h=setTimeout(()=>t.classList.remove('show'),2800); }
function fmtTime(ts){ if(!ts) return ''; const d=new Date(ts), n=new Date(); return d.toDateString()===n.toDateString() ? d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : d.toLocaleDateString([], {day:'numeric', month:'short'}); }
function pad4(n){ return String(n||0).padStart(4,'0'); }
function memberOf(id){ return S.members[id] || {}; }
function handleOf(id){ const m=memberOf(id); return m.handle ? '@'+m.handle : '@member'; }
function nameOf(id){ return memberOf(id).name || handleOf(id); }
function avatar(id, size){
  const m = memberOf(id);
  const box = h('div', {class:'mono', style: size?`width:${size}px;height:${size}px;font-size:${Math.round(size*.42)}px`:null});
  if (m.photo && /^https:\/\//.test(m.photo)) box.append(h('img', {src:m.photo, alt:'', referrerpolicy:'no-referrer'}));
  else box.textContent = (m.handle || '?').slice(0,1).toUpperCase();
  return box;
}
function dmId(a,b){ return 'dm_' + [a,b].sort().join('__'); }
function otherOf(chat){ return (chat.members||[]).find(x => x !== S.me.id); }
function myChats(){ return Object.entries(S.chats).map(([id,c]) => ({id, ...c})); }
function incomingKnocks(){ return myChats().filter(c => c.type==='dm' && c.status==='knock' && c.by !== S.me.id); }
async function guard(promise){
  try { return await promise; }
  catch(e){
    if (e && e.code === 'permission-denied') toast('This account is not on the test invite list. Ask SP to add your Google email.');
    else toast('That did not go through. Check your connection and try again.');
    throw e;
  }
}

/* ---------- Aurum sound set ---------- */
const SND = {};
['message','sent','knock','urgent','promise_sealed','signature'].forEach(k => { const a = new Audio('sounds/aurum_' + k + '.mp3'); a.preload = 'auto'; SND[k] = a; });
function soundsOn(){ try { return localStorage.getItem('aurum-sounds') !== 'off'; } catch(e){ return true; } }
function sound(k){
  if (!soundsOn()) return;
  const a = SND[k]; if (!a) return;
  try { a.currentTime = 0; const p = a.play(); if (p && p.catch) p.catch(() => {}); } catch(e){}
}
const seenTs = {}; let knockCount = null;

/* ---------- boot ---------- */
function boot(){
  render();
  if (!configured){ S.view = 'setup'; render(); return; }
  getRedirectResult(auth).catch(() => {});
  onAuthStateChanged(auth, user => {
    S.unsubs.forEach(u => u()); S.unsubs = [];
    if (S.msgUnsub){ S.msgUnsub(); S.msgUnsub = null; }
    if (!user){ S.me = null; S.view = 'signin'; render(); return; }
    S.me = {id:user.uid, name:user.displayName || '', photo:user.photoURL || '', email:user.email || ''};
    S.view = 'loading'; S.membersReady = false; render();
    startListeners();
  });
}
function startListeners(){
  const slowTimer = setTimeout(() => { S.slow = true; render(); }, 10000);
  S.unsubs.push(onSnapshot(collection(db, 'members'), snap => {
    S.members = {};
    snap.docs.forEach(d => { S.members[d.id] = d.data(); });
    if (!snap.metadata.fromCache){ S.membersReady = true; clearTimeout(slowTimer); S.slow = false; }
    if (S.view === 'loading' && S.membersReady) S.view = S.members[S.me.id] ? 'app' : 'join';
    render();
  }, err => { clearTimeout(slowTimer); S.view = err.code === 'permission-denied' ? 'notinvited' : 'error'; render(); }));

  S.unsubs.push(onSnapshot(doc(db, 'chats', CIRCLE), d => {
    if (d.exists()){ S.chats[CIRCLE] = d.data(); chatPing(CIRCLE, d.data()); } render();
  }, () => {}));
  S.unsubs.push(onSnapshot(query(collection(db, 'chats'), where('members', 'array-contains', S.me.id)), snap => {
    for (const id of Object.keys(S.chats)) if (id !== CIRCLE) delete S.chats[id];
    snap.docs.forEach(d => { S.chats[d.id] = d.data(); chatPing(d.id, d.data()); });
    const k = incomingKnocks().length;
    if (knockCount !== null && k > knockCount) sound('knock');
    knockCount = k;
    S.chatsReady = true; render();
  }, () => { S.chatsReady = true; render(); }));

  getDoc(doc(db, 'feedback', S.me.id)).then(d => { if (d.exists()){ S.myFeedback = d.data(); render(); } }).catch(() => {});
  // Only the owner passes the rules for reading everyone's feedback.
  S.unsubs.push(onSnapshot(collection(db, 'feedback'), snap => {
    S.isOwner = true;
    S.allFeedback = snap.docs.map(d => ({id:d.id, ...d.data()}));
    render();
  }, () => { S.isOwner = false; }));
}

function chatPing(id, c){
  const prev = seenTs[id];
  seenTs[id] = c.lastTs || 0;
  if (prev === undefined) return; // first load: stay quiet
  if ((c.lastTs || 0) > prev && c.lastFrom && c.lastFrom !== S.me.id && S.chatId !== id) sound('message');
}

/* ---------- render with input preservation ---------- */
function render(){
  const activeEl = document.activeElement;
  const active = activeEl && activeEl.id;
  let sel = null;
  try { if (active && activeEl.selectionStart != null) sel = [activeEl.selectionStart, activeEl.selectionEnd]; } catch(e){}
  const vals = {};
  app.querySelectorAll('input,textarea,select').forEach(i => { if (i.id) vals[i.id] = (i.type==='radio'||i.type==='checkbox') ? i.checked : i.value; });
  const list = document.getElementById('msglist');
  const nearBottom = !list || (list.scrollHeight - list.scrollTop - list.clientHeight < 80);
  const prevChat = app.dataset.chat;
  const screen = app.querySelector('.screen');
  const prevScroll = screen && !list ? screen.scrollTop : 0;
  const prevKey = app.dataset.key;

  app.replaceChildren(...view());

  for (const [id,v] of Object.entries(vals)){
    const el = document.getElementById(id); if (!el) continue;
    if (el.type==='radio'||el.type==='checkbox') el.checked = v; else el.value = v;
  }
  if (active){ const el = document.getElementById(active); if (el){ el.focus({preventScroll:true}); if (sel && el.setSelectionRange) try{ el.setSelectionRange(sel[0], sel[1]); }catch(e){} } }
  const nl = document.getElementById('msglist');
  if (nl && (nearBottom || prevChat !== S.chatId)) nl.scrollTop = nl.scrollHeight;
  const key = S.view + ':' + S.tab;
  const sc = app.querySelector('.screen');
  if (sc && !nl && prevKey === key) sc.scrollTop = prevScroll;
  app.dataset.chat = S.chatId || '';
  app.dataset.key = key;
}

function view(){
  if (S.view === 'loading') return [loadingView()];
  if (S.view === 'setup') return [messageView('Almost ready', 'The app is installed but not connected yet. Add the Firebase settings to docs/config.js (see TESTING-SETUP.md in the repository).')];
  if (S.view === 'signin') return [signInView()];
  if (S.view === 'notinvited') return [notInvitedView()];
  if (S.view === 'error') return [messageView('Something went wrong', 'Aurum could not load the circle. Close this page and open the link again.')];
  if (S.view === 'join') return [joinView()];
  if (S.view === 'chat') return chatView();
  return [h('div', {class:'screen'}, tabBody()), tabBar()];
}

/* ---------- simple screens ---------- */
function brand(size){ return h('h1', {class:'disp gt', style:`font-size:${size}px;letter-spacing:4px;font-weight:700`}, 'AURUM'); }
function loadingView(){
  return h('div', {class:'screen'}, h('div', {class:'pad stack', style:'align-items:center;text-align:center;gap:12px;padding-top:120px'},
    brand(44), h('p', {class:'muted', text:'Opening your private circle…'}),
    S.slow ? h('p', {class:'note', text:'This is taking longer than usual. Check your connection; Aurum opens as soon as it can reach the server.'}) : null));
}
function messageView(title, text){
  return h('div', {class:'screen'}, h('div', {class:'pad stack', style:'align-items:center;text-align:center;gap:14px;padding-top:96px'},
    brand(44), h('p', {style:'margin:0;font-size:16px', text:title}), h('p', {class:'note', style:'max-width:320px', text}) ));
}
function signInView(){
  const go = async () => {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({prompt:'select_account'});
    try { await signInWithPopup(auth, provider); }
    catch(e){
      if (e && (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment')) { await signInWithRedirect(auth, provider); }
      else if (e && e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') toast('Sign-in did not complete (' + ((e && e.code) || 'unknown') + '). Send SP a screenshot of this message.');
    }
  };
  return h('div', {class:'screen', style:'background:radial-gradient(circle at 50% 18%,rgba(42,34,21,.95) 0%,rgba(11,10,8,0) 58%)'},
    h('div', {class:'pad stack', style:'align-items:center;text-align:center;gap:16px;padding-top:90px'},
      h('div', {style:'width:92px;height:92px;border-radius:50%;border:2px solid transparent;background:radial-gradient(circle at 50% 40%,#1E1810,#0B0A08) padding-box,var(--metal) border-box;box-shadow:0 0 30px rgba(232,196,106,.35);display:grid;place-items:center'}, h('span', {class:'disp gt', style:'font-size:52px;font-weight:700', text:'A'})),
      brand(46),
      h('p', {class:'muted', style:'margin:0;line-height:1.5', text:'Private messaging for founders, creators and icons. By invitation only.'}),
      h('span', {class:'badge-test', text:'Founding test'}),
      h('button', {class:'btn', style:'width:100%;max-width:340px;margin-top:18px', onclick: go}, 'Continue with Google'),
      h('p', {class:'note', style:'max-width:320px', text:'Use the Google email SP invited. If the link opened inside WhatsApp or another app, open it in Chrome or Safari first.'})));
}
function notInvitedView(){
  return h('div', {class:'screen'}, h('div', {class:'pad stack', style:'align-items:center;text-align:center;gap:14px;padding-top:96px'},
    brand(44),
    h('p', {style:'margin:0;font-size:16px', text:'This test is invitation only.'}),
    h('p', {class:'note', style:'max-width:320px', text:'You signed in as ' + (S.me && S.me.email || 'an account') + ', which is not on the invite list. Ask SP to add this email, or sign in with the email SP invited.'}),
    h('button', {class:'ghost', onclick: () => signOut(auth)}, 'Use another account')));
}

/* ---------- join ---------- */
function joinView(){
  const roles = ['Founder','Investor','Professional','Creator','Business owner','Other'];
  const takenCount = Object.keys(S.members).length;
  const form = h('form', {class:'stack', style:'gap:18px', onsubmit: async ev => {
    ev.preventDefault();
    const handle = document.getElementById('j-handle').value.trim().toLowerCase().replace(/^@/,'');
    const role = (document.querySelector('input[name="j-role"]:checked')||{}).value;
    const adult = document.getElementById('j-adult').checked;
    const err = document.getElementById('j-err');
    if (!/^[a-z0-9_]{3,20}$/.test(handle)){ err.textContent = 'Choose a handle of 3–20 letters, numbers or underscores.'; return; }
    if (Object.entries(S.members).some(([id,m]) => id !== S.me.id && m.handle === handle)){ err.textContent = '@' + handle + ' is taken. Try another.'; return; }
    if (!role){ err.textContent = 'Choose what describes you best.'; return; }
    if (!adult){ err.textContent = 'Please confirm you are 18 or older.'; return; }
    err.textContent = '';
    const btn = document.getElementById('j-go'); btn.disabled = true;
    try {
      await guard(setDoc(doc(db, 'members', S.me.id), {handle, role, no: takenCount + 1, joinedAt: Date.now(), name: S.me.name.slice(0, 80), photo: S.me.photo}));
      const circle = await getDoc(doc(db, 'chats', CIRCLE));
      if (!circle.exists()) await guard(setDoc(doc(db, 'chats', CIRCLE), {type:'group', name:'Aurum Founders Circle', createdAt: Date.now()}));
      S.view = 'app'; S.tab = 'chats'; render();
      sound('signature');
      toast('Welcome to Aurum, @' + handle + '.');
    } catch(e){ btn.disabled = false; }
  }},
    h('div', {class:'stack', style:'gap:8px'},
      h('label', {class:'label', for:'j-handle', text:'Your handle'}),
      h('input', {class:'field', id:'j-handle', placeholder:'@yourname', autocomplete:'off', autocapitalize:'none', maxlength:'21'}),
      h('span', {class:'note', text:'Members find you by this handle. Your phone number is never shown.'})),
    h('fieldset', {style:'border:0;padding:0;margin:0', class:'stack'},
      h('legend', {class:'label', style:'margin-bottom:10px', text:'I am a'}),
      h('div', {class:'opt'}, roles.map((r,i) => h('label', {}, h('input', {type:'radio', name:'j-role', id:'j-role-'+i, value:r}), h('span', {text:r}))))),
    h('label', {class:'row note', style:'align-items:flex-start'},
      h('input', {type:'checkbox', id:'j-adult', style:'width:20px;height:20px;accent-color:#C9A24B;margin-top:1px;flex:none'}),
      h('span', {text:'I am 18 or older and understand this is an early test. Test chats are not end-to-end encrypted yet, so please keep them light.'})),
    h('p', {id:'j-err', class:'note', style:'color:var(--urgent);margin:0;min-height:18px', role:'alert'}),
    h('button', {class:'btn', id:'j-go', type:'submit'}, 'Take my seat')
  );
  return h('div', {class:'screen', style:'background:radial-gradient(circle at 50% 10%,rgba(42,34,21,.95) 0%,rgba(11,10,8,0) 55%)'},
    h('div', {class:'pad stack', style:'gap:22px'},
      h('div', {class:'stack', style:'align-items:center;text-align:center;gap:8px;padding-top:24px'},
        brand(44),
        h('p', {class:'muted', style:'margin:0;line-height:1.5', text:'Private messaging for founders, creators and icons.'}),
        h('span', {class:'badge-test', text:'Founding test · seat No. ' + pad4(takenCount + 1)})),
      form));
}

/* ---------- tabs ---------- */
function tabBar(){
  const knocks = incomingKnocks().length;
  const t = (k, ic, l, badge) => h('button', {class: S.tab===k?'on':null, 'aria-current': S.tab===k?'page':null, onclick: () => { S.tab = k; S.knockFor = null; render(); }},
    h('span', {html: ICON[ic]}), l, badge ? h('span', {class:'dot', text:String(badge)}) : null);
  return h('nav', {class:'tabs', 'aria-label':'Main'}, t('chats','chats','Chats', knocks), t('members','members','Members'), t('card','card','My Card'), t('feedback','feedback','Feedback'));
}
function tabBody(){
  if (S.tab === 'members') return membersTab();
  if (S.tab === 'card') return cardTab();
  if (S.tab === 'feedback') return feedbackTab();
  return chatsTab();
}
function head(eyebrow, title){
  return h('div', {class:'stack', style:'gap:2px;margin-bottom:16px'}, h('span', {class:'label', text:eyebrow}), h('h1', {class:'disp gt', style:'font-size:34px', text:title}));
}
function acceptKnock(id, then){
  return guard(updateDoc(doc(db, 'chats', id), {status:'open', openedAt: Date.now()})).then(then).catch(() => {});
}
function chatsTab(){
  const me = memberOf(S.me.id);
  const knocks = incomingKnocks();
  const chats = myChats().filter(c => c.id === CIRCLE || c.status === 'open' || ((c.status === 'knock' || c.status === 'ignored') && c.by === S.me.id))
    .sort((a,b) => (b.lastTs||b.createdAt||0) - (a.lastTs||a.createdAt||0));
  return h('div', {class:'pad'},
    head('Founding member No. ' + pad4(me.no), 'Aurum'),
    knocks.length ? h('div', {class:'stack', style:'gap:10px;margin-bottom:18px'},
      h('span', {class:'label', text:'Knock requests'}),
      knocks.map(k => h('div', {class:'card gold row'},
        avatar(k.by),
        h('div', {class:'stack', style:'flex:1;min-width:0;gap:3px'},
          h('b', {class:'ellip', text: nameOf(k.by)}),
          h('span', {class:'note ellip', text: k.note ? '“' + k.note + '”' : handleOf(k.by) + ' would like to message you'})),
        h('div', {class:'stack', style:'gap:6px'},
          h('button', {class:'btn sm', onclick: () => acceptKnock(k.id, () => toast('You can now chat with ' + handleOf(k.by) + '.'))}, 'Accept'),
          h('button', {class:'ghost sm', onclick: () => guard(updateDoc(doc(db, 'chats', k.id), {status:'ignored'})).catch(()=>{})}, 'Ignore'))))) : null,
    !S.chatsReady ? h('p', {class:'note', text:'Loading chats…'}) :
    chats.map(c => {
      const isGroup = c.id === CIRCLE;
      const other = isGroup ? null : otherOf(c);
      const waiting = c.status === 'knock' || c.status === 'ignored';
      const last = waiting ? 'Knock sent · waiting for ' + handleOf(other) : (c.lastText ? (c.lastFrom === S.me.id ? 'You: ' : '') + c.lastText : (isGroup ? 'Say hello to the circle' : 'Start the conversation'));
      return h('button', {class:'list-row', onclick: () => openChat(c.id)},
        isGroup ? h('div', {class:'ring'}, h('div', {class:'mono', text:'A'})) : avatar(other),
        h('div', {class:'stack', style:'flex:1;min-width:0;gap:4px'},
          h('b', {class:'ellip', style:'font-size:15px', text: isGroup ? (c.name || 'Aurum Founders Circle') : nameOf(other)}),
          h('span', {class:'muted ellip', style:'font-size:13px', text: last})),
        h('span', {class:'muted', style:'font-size:11px', text: fmtTime(c.lastTs)}));
    }),
    h('p', {class:'note', style:'margin-top:18px', text:'Want to message someone new? Knock from the Members tab. Nobody can message you without your permission.'}));
}

function membersTab(){
  const ids = Object.keys(S.members).filter(id => id !== S.me.id).sort((a,b) => (S.members[a].no||0) - (S.members[b].no||0));
  return h('div', {class:'pad'},
    head('Verified circle · ' + Object.keys(S.members).length + ' members', 'Members'),
    ids.length === 0 ? h('p', {class:'note card', text:'You are the first member here. As others take their seats, they appear in this list and you can knock to start a private chat.'}) : null,
    ids.map(id => {
      const m = S.members[id], cid = dmId(S.me.id, id), c = S.chats[cid];
      let action;
      if (c && c.status === 'open') action = h('button', {class:'ghost sm', onclick: () => openChat(cid)}, 'Message');
      else if (c && c.status === 'knock' && c.by !== S.me.id) action = h('button', {class:'btn sm', onclick: () => acceptKnock(cid, () => openChat(cid))}, 'Accept knock');
      else if (c && (c.status === 'knock' || c.status === 'ignored')) action = h('span', {class:'note', text:'Knock sent'});
      else action = h('button', {class:'btn sm', onclick: () => { S.knockFor = (S.knockFor === id ? null : id); render(); setTimeout(()=>{ const n=document.getElementById('knock-note'); if(n) n.focus(); }, 0); }}, 'Knock');
      return h('div', {style:'border-bottom:1px solid var(--line)'},
        h('div', {class:'row', style:'padding:12px 0'},
          avatar(id),
          h('div', {class:'stack', style:'flex:1;min-width:0;gap:3px'},
            h('b', {class:'ellip', text: nameOf(id)}),
            h('span', {class:'note ellip', text: handleOf(id) + ' · ' + (m.role || 'Member') + ' · No. ' + pad4(m.no)})),
          action),
        S.knockFor === id ? h('form', {class:'stack', style:'gap:8px;padding-bottom:14px', onsubmit: async ev => {
            ev.preventDefault();
            const note = document.getElementById('knock-note').value.trim().slice(0, 140);
            try {
              await guard(setDoc(doc(db, 'chats', cid), {type:'dm', members:[S.me.id, id].sort(), status:'knock', by:S.me.id, note, createdAt: Date.now()}));
              S.knockFor = null; render(); toast('Knock sent to ' + handleOf(id) + '.');
            } catch(e){}
          }},
          h('label', {class:'note', for:'knock-note', text:'Add a short note so ' + handleOf(id) + ' knows why you are knocking (optional).'}),
          h('input', {class:'field', id:'knock-note', maxlength:'140', placeholder:'e.g. Loved your talk, would like to connect'}),
          h('div', {class:'row'}, h('button', {class:'btn sm', type:'submit'}, 'Send knock'), h('button', {class:'ghost sm', type:'button', onclick: () => { S.knockFor = null; render(); }}, 'Cancel'))) : null);
    }));
}

function cardTab(){
  const m = memberOf(S.me.id);
  const since = m.joinedAt ? new Date(m.joinedAt).getFullYear() : new Date().getFullYear();
  const feats = [
    ['Knock to connect', 'Nobody can message you until you accept their knock.'],
    ['Message priority', 'Mark a message Whenever, Today or Urgent so people know what matters.'],
    ['Promise', 'Send a promise in a private chat. When accepted, a gold seal closes on it; both mark it Kept.'],
    ['Handle, not number', 'Members see your @handle. Your phone number is never shown.'],
    ['Founding number', 'Your seat number is yours for as long as you are a member.']
  ];
  return h('div', {class:'pad'},
    head('My membership', 'My Card'),
    h('div', {class:'mcard'},
      h('div', {class:'row'}, h('span', {class:'disp gt', style:'font-size:24px;font-weight:700;letter-spacing:2px;flex:1', text:'AURUM'}), h('span', {class:'tier', text:'FOUNDING'})),
      h('div', {class:'stack'}, h('span', {class:'disp gt', style:'font-size:42px;font-weight:700', text:'@' + (m.handle || 'member')}),
        h('span', {class:'muted', style:'font-size:12px', text:(m.role || 'Member') + ' · Founding member No. ' + pad4(m.no)})),
      h('div', {class:'row'}, h('span', {class:'label', style:'flex:1', text:'Member since ' + since}), h('span', {class:'note', text:'Founding test'}))),
    h('h2', {class:'disp', style:'font-size:24px;color:var(--text);margin:26px 0 8px', text:'Try these in the test'}),
    feats.map(f => h('div', {style:'padding:11px 0;border-bottom:1px solid var(--line)'}, h('b', {style:'display:block;font-size:14px', text:f[0]}), h('span', {class:'note', text:f[1]}))),
    h('label', {class:'row', style:'justify-content:space-between;padding:14px 0;border-bottom:1px solid var(--line);margin-top:10px'},
      h('span', {}, h('b', {style:'display:block;font-size:14px', text:'Aurum sounds'}), h('span', {class:'note', text:'Champagne crystal for messages, santoor for the signature.'})),
      h('input', {type:'checkbox', id:'snd-toggle', checked: soundsOn() || null, style:'width:22px;height:22px;accent-color:#C9A24B', onchange: ev => { try { localStorage.setItem('aurum-sounds', ev.target.checked ? 'on' : 'off'); } catch(e){} if (ev.target.checked) sound('message'); }})),
    h('button', {class:'ghost', style:'margin-top:22px;width:100%', onclick: () => signOut(auth)}, 'Sign out'));
}

/* ---------- feedback ---------- */
const FB = [
  {id:'understand', q:'In your own words, what is Aurum for?', type:'text'},
  {id:'liked', q:'What did you like most?', type:'text'},
  {id:'confusing', q:'What was confusing or missing?', type:'text'},
  {id:'stop', q:'What would stop you from using it every day?', type:'text'},
  {id:'pain', q:'When did spam, a scam or an unwanted message last bother you? What happened?', type:'text'},
  {id:'rating', q:'Overall, how much do you want Aurum to exist?', type:'choice', opts:['1','2','3','4','5']},
  {id:'pay', q:'The first 500 Founding Memberships will be ₹10,000 a year. Would you take one if it opened today?', type:'choice', opts:['Yes, count me in','Maybe later','Not at that price']},
  {id:'price', q:'What yearly price feels right to you, and why?', type:'text'},
  {id:'parents', q:'Would you want a simpler, safer version for your parents or family?', type:'choice', opts:['Yes','Maybe','No']}
];
function feedbackTab(){
  const saved = S.myFeedback || {};
  const form = h('form', {class:'stack', style:'gap:18px', onsubmit: async ev => {
    ev.preventDefault();
    const data = {ts: Date.now(), name: S.me.name.slice(0, 80), handle: memberOf(S.me.id).handle || ''};
    for (const f of FB){
      if (f.type === 'text') data[f.id] = document.getElementById('fb-' + f.id).value.trim().slice(0, 1200);
      else { const c = document.querySelector('input[name="fb-' + f.id + '"]:checked'); data[f.id] = c ? c.value : ''; }
    }
    const btn = document.getElementById('fb-go'); btn.disabled = true;
    try { await guard(setDoc(doc(db, 'feedback', S.me.id), data)); S.myFeedback = data; toast('Thank you. Your feedback reached SP.'); }
    catch(e){} finally { btn.disabled = false; render(); }
  }},
    FB.map(f => f.type === 'text'
      ? h('div', {class:'stack', style:'gap:8px'}, h('label', {for:'fb-' + f.id, style:'font-size:14px;line-height:1.4', text:f.q}), (() => { const t = h('textarea', {class:'field', id:'fb-' + f.id, rows:'3'}); t.value = saved[f.id] || ''; return t; })())
      : h('fieldset', {style:'border:0;padding:0;margin:0', class:'stack'}, h('legend', {style:'font-size:14px;line-height:1.4;margin-bottom:10px', text:f.q}),
          h('div', {class:'opt'}, f.opts.map((o,i) => h('label', {}, h('input', {type:'radio', name:'fb-' + f.id, id:'fb-' + f.id + '-' + i, value:o, checked: saved[f.id] === o || null}), h('span', {text:o})))))),
    h('button', {class:'btn', id:'fb-go', type:'submit'}, S.myFeedback ? 'Update my feedback' : 'Send feedback to SP'),
    h('p', {class:'note', style:'margin:0', text:'Only SP can read your answers. Be honest; criticism helps most.'}));
  return h('div', {class:'pad'},
    head('Your honest view', 'Feedback'),
    S.isOwner ? ownerResults() : null,
    form);
}
function ownerResults(){
  const rows = S.allFeedback.slice().sort((a,b) => (b.ts||0) - (a.ts||0));
  const payYes = rows.filter(r => r.pay === 'Yes, count me in').length;
  const rated = rows.filter(r => r.rating);
  const avg = rated.length ? rated.reduce((s,r) => s + (parseInt(r.rating)||0), 0) / rated.length : 0;
  return h('div', {class:'card gold stack', style:'gap:12px;margin-bottom:24px'},
    h('span', {class:'label', style:'color:var(--gold)', text:'Responses (visible only to you)'}),
    h('div', {class:'row', style:'gap:18px;font-variant-numeric:tabular-nums'},
      h('div', {class:'stack'}, h('span', {class:'disp gt', style:'font-size:30px', text:String(rows.length)}), h('span', {class:'note', text:'responses'})),
      h('div', {class:'stack'}, h('span', {class:'disp gt', style:'font-size:30px', text:rated.length ? avg.toFixed(1) : '—'}), h('span', {class:'note', text:'avg. want (1–5)'})),
      h('div', {class:'stack'}, h('span', {class:'disp gt', style:'font-size:30px', text:payYes + '/' + rows.length}), h('span', {class:'note', text:'would pay ₹10,000'}))),
    rows.length === 0 ? h('p', {class:'note', style:'margin:0', text:'No responses yet. They appear here as your testers send feedback.'}) : null,
    rows.map(r => h('details', {style:'border-top:1px solid var(--line);padding-top:10px'},
      h('summary', {style:'cursor:pointer'}, h('b', {text: r.name || (r.handle ? '@' + r.handle : nameOf(r.id))}), h('span', {class:'note', text:' · ' + (r.pay || 'no answer') + ' · want ' + (r.rating || '—') + '/5'})),
      h('div', {class:'stack', style:'gap:8px;margin-top:8px'},
        FB.filter(f => r[f.id]).map(f => h('div', {}, h('div', {class:'note', text:f.q}), h('div', {style:'white-space:pre-wrap;line-height:1.45', text:r[f.id]})))))));
}

/* ---------- chat ---------- */
function openChat(id){
  if (S.msgUnsub){ S.msgUnsub(); S.msgUnsub = null; }
  S.chatId = id; S.msgs = []; S.view = 'chat'; S.priority = 'whenever'; S.promiseMode = false;
  const chat = S.chats[id] || {};
  if (id === CIRCLE || chat.status === 'open'){
    let first = true;
    S.msgUnsub = onSnapshot(query(collection(db, 'chats', id, 'msgs'), orderBy('ts', 'desc'), limit(200)), snap => {
      if (!first){
        snap.docChanges().forEach(ch => {
          if (ch.doc.metadata.hasPendingWrites) return;
          const m = ch.doc.data();
          if (ch.type === 'added' && m.from !== S.me.id) sound(m.priority === 'urgent' ? 'urgent' : 'message');
          if (ch.type === 'modified' && m.kind === 'promise' && m.from === S.me.id && m.promise && m.promise.status === 'sealed') sound('promise_sealed');
        });
      }
      first = false;
      S.msgs = snap.docs.map(d => ({id:d.id, ...d.data()})).reverse();
      render();
    }, () => toast('Messages could not load. Go back and open the chat again.'));
  }
  render();
}
function closeChat(){
  if (S.msgUnsub){ S.msgUnsub(); S.msgUnsub = null; }
  S.view = 'app'; S.chatId = null; render();
}
async function sendMessage(){
  const box = document.getElementById('composer-text');
  const text = box.value.trim().slice(0, 2000);
  if (!text) return;
  const isPromise = S.promiseMode;
  const due = isPromise ? (document.getElementById('promise-due') || {}).value || '' : '';
  const msg = {from:S.me.id, text, ts: Date.now(), priority: isPromise ? 'whenever' : S.priority, kind: isPromise ? 'promise' : 'text'};
  if (isPromise) msg.promise = {status:'proposed', due};
  box.value = '';
  const btn = document.getElementById('send-btn'); if (btn) btn.disabled = true;
  try {
    await guard(addDoc(collection(db, 'chats', S.chatId, 'msgs'), msg));
    await guard(updateDoc(doc(db, 'chats', S.chatId), {lastText: isPromise ? 'Promise: ' + text : text, lastTs: msg.ts, lastFrom: S.me.id}));
    S.promiseMode = false; S.priority = 'whenever';
    sound('sent');
  } catch(e){ box.value = text; }
  finally { render(); const b = document.getElementById('composer-text'); if (b) b.focus(); }
}
function setPromise(m, fields, msg){
  return guard(updateDoc(doc(db, 'chats', S.chatId, 'msgs', m.id), fields)).then(() => toast(msg)).catch(() => {});
}
function promiseCard(m, chat){
  const p = m.promise || {};
  const mine = m.from === S.me.id;
  const status = p.status || 'proposed';
  const sealed = status === 'sealed' || status === 'kept';
  const act = [];
  if (status === 'proposed' && !mine) act.push(h('button', {class:'btn sm', onclick: () => { sound('promise_sealed'); setPromise(m, {'promise.status':'sealed', 'promise.sealedAt': Date.now()}, 'Promise sealed.'); }}, 'Accept and seal'));
  if (status === 'sealed') act.push(h('button', {class:'ghost sm', onclick: () => setPromise(m, {'promise.status':'kept', 'promise.keptAt': Date.now()}, 'Promise kept.')}, 'Mark kept'));
  const statusText = status === 'proposed' ? (mine ? 'Waiting for ' + handleOf(otherOf(chat)) + ' to accept' : handleOf(m.from) + ' made you a promise')
    : status === 'sealed' ? 'Sealed · cannot be edited' : 'Kept · promise fulfilled';
  return h('div', {class:'promise'},
    h('div', {class:'seal' + (sealed ? ' on' : ''), 'aria-hidden':'true', text:'A'}),
    h('div', {class:'label', style:'color:var(--gold)', text: status === 'kept' ? 'Promise kept' : 'Promise'}),
    h('p', {class:'disp', style:'font-size:20px;color:var(--text);margin:6px 0', text: m.text}),
    p.due ? h('div', {class:'note', text:'By ' + new Date(p.due + 'T00:00').toLocaleDateString([], {day:'numeric', month:'short', year:'numeric'})}) : null,
    h('div', {class:'note', style:'margin-top:6px', text: statusText + ' · from ' + handleOf(m.from) + ' · ' + fmtTime(m.ts)}),
    act.length ? h('div', {class:'row', style:'justify-content:center;margin-top:10px'}, act) : null);
}
function chatView(){
  const chat = S.chats[S.chatId] || {};
  const isGroup = S.chatId === CIRCLE;
  const other = isGroup ? null : otherOf(chat);
  const blocked = !isGroup && chat.status !== 'open';
  if (!blocked && !S.msgUnsub && S.chatId){ setTimeout(() => openChat(S.chatId), 0); }
  const title = isGroup ? (chat.name || 'Aurum Founders Circle') : nameOf(other);
  const sub = isGroup ? Object.keys(S.members).length + ' verified members' : handleOf(other) + ' · ' + (memberOf(other).role || 'Member') + ' · No. ' + pad4(memberOf(other).no);

  const top = h('div', {class:'topbar'},
    h('button', {class:'iconbtn', 'aria-label':'Back to chats', onclick: closeChat, html: ICON.back}),
    isGroup ? h('div', {class:'ring'}, h('div', {class:'mono', style:'width:40px;height:40px;font-size:18px', text:'A'})) : h('div', {class:'ring'}, avatar(other, 40)),
    h('div', {class:'stack', style:'flex:1;min-width:0'}, h('b', {class:'ellip', style:'font-size:16px', text:title}), h('span', {class:'note ellip', style:'font-size:11px', text:sub})));

  const list = h('div', {class:'screen', id:'msglist'}, h('div', {class:'pad msgs', style:'padding-top:12px'},
    h('span', {class:'row note', style:'align-self:center;gap:6px;font-size:11px;border:1px solid var(--line);border-radius:14px;padding:6px 12px;margin-bottom:8px'}, h('span', {style:'color:var(--gold)', html:ICON.lock}), 'Verified members only · Test chat'),
    S.msgs.length === 0 ? h('p', {class:'note', style:'align-self:center;text-align:center;max-width:280px', text: blocked ? '' : (isGroup ? 'This is the founding circle. Say hello.' : 'Your knock was accepted. Start the conversation.')}) : null,
    S.msgs.map(m => {
      if (m.kind === 'promise') return promiseCard(m, chat);
      const mine = m.from === S.me.id;
      return h('div', {class:'bubble ' + (mine ? 'me' : 'them')},
        isGroup && !mine ? h('div', {class:'who', text: nameOf(m.from)}) : null,
        m.priority === 'today' ? h('div', {}, h('span', {class:'prio today', text:'Today'})) : null,
        m.priority === 'urgent' ? h('div', {}, h('span', {class:'prio urgent', text:'Urgent'})) : null,
        h('span', {text: m.text}),
        h('div', {class:'meta', text: fmtTime(m.ts)}));
    })));

  let bottom;
  if (blocked){
    bottom = h('div', {class:'composer'}, h('p', {class:'note', style:'margin:0;text-align:center', text: chat.by === S.me.id ? 'Waiting for ' + handleOf(other) + ' to accept your knock.' : 'Accept the knock on the Chats tab to reply.'}));
  } else {
    const prio = (k, l, cls) => h('button', {type:'button', class:'chip' + (cls ? ' ' + cls : '') + (S.priority === k ? ' on' : ''), 'aria-pressed': String(S.priority === k), onclick: () => { S.priority = k; render(); }}, l);
    bottom = h('form', {class:'composer', onsubmit: ev => { ev.preventDefault(); sendMessage(); }},
      h('div', {class:'row', style:'gap:6px;flex-wrap:wrap'},
        S.promiseMode ? h('span', {class:'label', style:'color:var(--gold)', text:'New promise'}) : [prio('whenever','Whenever'), prio('today','Today'), prio('urgent','Urgent','urgent')],
        !isGroup ? h('button', {type:'button', class:'chip' + (S.promiseMode ? ' on' : ''), 'aria-pressed': String(S.promiseMode), style:'margin-left:auto', onclick: () => { S.promiseMode = !S.promiseMode; render(); const b=document.getElementById('composer-text'); if(b) b.focus(); }}, S.promiseMode ? 'Cancel promise' : 'Promise') : null),
      S.promiseMode ? h('div', {class:'row'}, h('label', {class:'note', for:'promise-due', text:'Keep it by (optional)'}), h('input', {type:'date', id:'promise-due', class:'field', style:'min-height:38px;padding:6px 10px;width:auto;flex:1'})) : null,
      h('div', {class:'line'},
        h('textarea', {id:'composer-text', rows:'1', 'aria-label': S.promiseMode ? 'Your promise' : 'Message', placeholder: S.promiseMode ? 'I promise to…' : 'Message', maxlength:'2000',
          onkeydown: ev => { if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing){ ev.preventDefault(); sendMessage(); } }}),
        h('button', {class:'send', id:'send-btn', type:'submit', 'aria-label': S.promiseMode ? 'Send promise' : 'Send', html: ICON.send})));
  }
  return [top, list, bottom];
}

boot();
