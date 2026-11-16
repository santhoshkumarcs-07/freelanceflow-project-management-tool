import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './overrides.css';

const nav = [
  { label: 'Workspace', items: [['Overview', '⌂'], ['Projects', '▦'], ['Clients', '◉'], ['Tasks', '☷']] },
  { label: 'Keep track', items: [['Time', '◷'], ['Invoices', '▤'], ['Reports', '⌁']] },
];
const emptyData = { clients: [], projects: [], invoices: [], entries: [], tasks: [] };
const API_BASE = import.meta.env.VITE_API_BASE || '';
const money = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n || 0);
const day = d => d ? new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'No date';
async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}/api${path}`, {
    credentials: 'include',
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
  });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(payload.error || 'Request failed.'); error.status = response.status; throw error; }
  return payload;
}
function App() {
  const [data, setData] = useState(emptyData);
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [apiAvailable, setApiAvailable] = useState(true);
  const [dashboard, setDashboard] = useState(null);
  const [reportData, setReportData] = useState(null);
  const [page, setPage] = useState('Overview');
  const [modal, setModal] = useState('');
  const [editing, setEditing] = useState(null);
  const [toast, setToast] = useState('');
  const [filter, setFilter] = useState('All projects');
  const [timer, setTimer] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef(null);
  useEffect(() => {
    let alive = true;
    api('/health').then(health => {
      if (!health.ok) throw new Error('API health check failed.');
      if (alive) setApiAvailable(true);
      return api('/auth/me');
    })
      .then(({ user: currentUser }) => { if (alive) setUser(currentUser); })
      .catch(error => { if (alive && (!error.status || error.status >= 500)) setApiAvailable(false); })
      .finally(() => { if (alive) setAuthLoading(false); });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (!user) return;
    let alive = true;
    Promise.all([api('/data'), api('/dashboard')]).then(([workspace, summary]) => {
      if (!alive) return;
      setData(workspace); setTimer(workspace.timer); setDashboard(summary); setApiAvailable(true);
    }).catch(error => { if (alive) notify(error.message || 'Could not load your workspace.'); });
    return () => { alive = false; };
  }, [user]);
  useEffect(() => {
    if (user && page === 'Reports') api('/reports').then(setReportData).catch(error => notify(error.message));
  }, [user, page]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => {
    const onShortcut = e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); searchRef.current?.focus(); setSearchOpen(true); } };
    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  }, []);
  const clientName = id => data.clients.find(c => c.id === id)?.name || 'Unknown client';
  const projectName = id => data.projects.find(p => p.id === id)?.name || 'Unknown project';
  const q = search.trim().toLowerCase();
  const searchMatches = useMemo(() => {
    if (!q) return [];
    const hits = [
      ...data.projects.filter(p => `${p.name} ${clientName(p.clientId)}`.toLowerCase().includes(q)).map(p => ({ title: p.name, detail: `${clientName(p.clientId)} · Project`, page: 'Projects' })),
      ...data.clients.filter(c => `${c.name} ${c.contact} ${c.email}`.toLowerCase().includes(q)).map(c => ({ title: c.name, detail: `${c.contact} · Client`, page: 'Clients' })),
      ...data.tasks.filter(t => `${t.title} ${projectName(t.projectId)}`.toLowerCase().includes(q)).map(t => ({ title: t.title, detail: `${projectName(t.projectId)} · Task`, page: 'Tasks' })),
      ...data.invoices.filter(i => `${i.number || i.id} ${clientName(i.clientId)} ${i.status}`.toLowerCase().includes(q)).map(i => ({ title: i.number || i.id, detail: `${clientName(i.clientId)} · Invoice`, page: 'Invoices' })),
      ...data.entries.filter(e => `${e.note} ${projectName(e.projectId)}`.toLowerCase().includes(q)).map(e => ({ title: e.note, detail: `${projectName(e.projectId)} · Time entry`, page: 'Time' })),
    ];
    return hits.slice(0, 7);
  }, [q, data]);
  const openSearchMatch = match => { setPage(match.page); setSearch(''); setSearchOpen(false); };
  const notify = msg => { setToast(msg); setTimeout(() => setToast(''), 2600); };
  const activeProjects = data.projects.filter(p => p.status === 'In progress');
  const filteredClients = data.clients.filter(c => `${c.name} ${c.contact} ${c.email}`.toLowerCase().includes(search.trim().toLowerCase()));
  const outstanding = data.invoices.filter(i => i.status !== 'Paid').reduce((s, i) => s + i.amount, 0);
  const monthStart = `${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,'0')}-01`;
  const weekStart = new Date(); weekStart.setHours(0,0,0,0); weekStart.setDate(weekStart.getDate() - ((weekStart.getDay()+6)%7));
  const weekly = Array.from({length:7},(_,index)=>{const date=new Date(weekStart);date.setDate(date.getDate()+index);const key=`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;return{day:date.toLocaleDateString('en-US',{weekday:'short'}),value:data.entries.filter(entry=>entry.date===key).reduce((total,entry)=>total+entry.hours,0)};});
  const hoursWeek = weekly.reduce((sum, item) => sum + item.value, 0);
  const hoursMonth = data.entries.filter(entry => entry.date >= monthStart).reduce((sum, entry) => sum + entry.hours, 0);
  const unbilledAmount = data.entries.filter(entry => !entry.invoiceId).reduce((sum, entry) => sum + entry.hours * entry.rate, 0);
  const paidYear = data.invoices.filter(invoice => invoice.status === 'Paid' && invoice.date?.slice(0,4) === String(new Date().getFullYear())).reduce((sum, invoice) => sum + invoice.amount, 0);
  const reportMonths = reportData?.months || [];
  const reportMax = Math.max(10000,...reportMonths.map(item=>item.revenue));
  const refreshWorkspace = async () => {
    const [workspace, summary] = await Promise.all([api('/data'), api('/dashboard')]);
    setData(workspace); setTimer(workspace.timer); setDashboard(summary); return workspace;
  };
  const closeModal = () => { setModal(''); setEditing(null); };
  const beginEdit = (kind, record) => {
    setEditing({ kind, record });
    setModal(kind === 'entries' ? 'quick' : kind.slice(0, -1));
  };
  const updateRecord = async (kind, id, form) => {
    try {
      const endpoints = { clients: '/clients', projects: '/projects', tasks: '/tasks', entries: '/time-entries' };
      let payload = form;
      if (kind === 'clients') { const { rate, ...fields } = form; payload = { ...fields, hourlyRate: Number(rate) || 0 }; }
      if (kind === 'projects' || kind === 'tasks') { const { due, ...fields } = form; payload = { ...fields, dueDate: due || null }; }
      if (kind === 'entries') payload = { ...form, hours: Number(form.hours) };
      await api(`${endpoints[kind]}/${id}`, { method: 'PUT', body: payload });
      await refreshWorkspace(); closeModal(); notify('Changes saved');
    } catch (error) { notify(error.message); }
  };
  const deleteRecord = async (kind, record) => {
    const endpoints = { clients: '/clients', projects: '/projects', tasks: '/tasks', entries: '/time-entries' };
    const noun = { clients: 'client', projects: 'project', tasks: 'task', entries: 'time entry' }[kind];
    if (!window.confirm(`Delete this ${noun}? This cannot be undone.`)) return;
    try {
      await api(`${endpoints[kind]}/${record.id}`, { method: 'DELETE' });
      await refreshWorkspace(); notify(`${noun[0].toUpperCase()}${noun.slice(1)} deleted`);
    } catch (error) { notify(error.message); }
  };
  const addRecord = async (kind, record) => {
    try {
      const endpoints = { clients: '/clients', projects: '/projects', tasks: '/tasks' };
      let payload = record;
      if (kind === 'clients') { const { rate, ...fields } = record; payload = { ...fields, hourlyRate: rate }; }
      if (kind === 'projects') { const { due, ...fields } = record; payload = { ...fields, dueDate: due || null }; }
      if (kind === 'tasks') { const { due, ...fields } = record; payload = { ...fields, dueDate: due || null }; }
      await api(endpoints[kind], { method: 'POST', body: payload });
      await refreshWorkspace(); closeModal(); notify(`${kind === 'clients' ? 'Client' : kind === 'projects' ? 'Project' : 'Task'} added`);
    } catch (error) { notify(error.message); }
  };
  const closeTimer = async () => {
    if (!timer) return;
    try { await api('/timer/stop', { method: 'POST' }); await refreshWorkspace(); notify('Time entry saved'); }
    catch (error) { notify(error.message); }
  };
  const startTimer = async form => {
    try { const result = await api('/timer', { method: 'POST', body: form }); setTimer(result.timer); closeModal(); notify('Timer started'); }
    catch (error) { notify(error.message); }
  };
  const saveTimeEntry = async form => {
    try { await api('/time-entries', { method: 'POST', body: form }); await refreshWorkspace(); closeModal(); notify('Time entry saved'); }
    catch (error) { notify(error.message); }
  };
  const toggleTask = async task => {
    try { await api(`/tasks/${task.id}`, { method: 'PUT', body: { projectId: task.projectId, title: task.title, dueDate: task.due || null, done: !task.done } }); await refreshWorkspace(); }
    catch (error) { notify(error.message); }
  };
  const markInvoicePaid = async invoice => {
    try { await api(`/invoices/${invoice.id}/status`, { method: 'PATCH', body: { status: invoice.status === 'Paid' ? 'Awaiting payment' : 'Paid' } }); await refreshWorkspace(); notify(invoice.status === 'Paid' ? 'Invoice reopened' : 'Invoice marked as paid'); }
    catch (error) { notify(error.message); }
  };
  const createInvoice = async form => {
    try { await api('/invoices', { method: 'POST', body: form }); await refreshWorkspace(); closeModal(); notify('Invoice created from unbilled time'); }
    catch (error) { notify(error.message); }
  };
  const loadSampleData = async () => {
    try { await api('/sample-data', { method: 'POST', body: {} }); await refreshWorkspace(); notify('Sample data loaded'); }
    catch (error) { notify(error.message); }
  };
  const signOut = async () => { try { await api('/auth/logout', { method: 'POST' }); } finally { setUser(null); setData(emptyData); setTimer(null); setDashboard(null); setPage('Overview'); } };
  const downloadInvoice = async inv => {
    try {
      const response = await fetch(`${API_BASE}/api/invoices/${inv.id}/pdf`, { credentials: 'include' });
      if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new Error(payload.error || 'Could not download invoice.'); }
      const file = URL.createObjectURL(await response.blob());
      const link = document.createElement('a'); link.href = file; link.download = `invoice-${inv.number || inv.id}.pdf`; link.click();
      URL.revokeObjectURL(file); notify('Invoice PDF downloaded');
    } catch (error) { notify(error.message); }
  };
  const isToday = d => d === new Date().toISOString().slice(0, 10);
  if (authLoading) return <div className="auth-screen"><div className="auth-card"><div className="brand"><div className="brand-mark"><span></span><span></span><span></span></div><span>freelance<span className="brand-light">flow</span></span></div><p>Opening your workspace…</p></div></div>;
  if (!user) return <AuthScreen apiAvailable={apiAvailable} onAuthenticated={setUser} />;
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><span></span><span></span><span></span></div><span>freelance<span className="brand-light">flow</span></span></div>
      <div className="workspace-switch"><div className="avatar avatar-dark">{(user.name || 'F').slice(0,1).toUpperCase()}</div><span className="workspace-name"><b>{user.name}'s workspace</b><small>{user.plan === 'pro' ? 'Pro plan' : 'Free plan'}</small></span></div>
      <div className="nav-groups">{nav.map(group => <section className="nav-group" key={group.label}><p className="nav-heading">{group.label}</p>{group.items.map(([label, icon]) => <button key={label} className={`nav-item ${page === label ? 'selected' : ''}`} onClick={() => setPage(label)}><span className="nav-icon">{icon}</span>{label}{label === 'Tasks' && <span className="nav-count">{data.tasks.filter(t => !t.done).length}</span>}</button>)}</section>)}</div>
      <div className="sidebar-bottom"><div className="plan-card"><div className="plan-top"><span className="plan-dot"></span><span>{user.plan === 'pro' ? 'Pro plan' : 'Free plan'}</span><span className="plan-limit">{user.plan === 'pro' ? 'Unlimited clients' : `${data.clients.length}/2 clients`}</span></div><div className="plan-track"><i style={{ width: user.plan === 'pro' ? '100%' : `${Math.min(100,data.clients.length*50)}%` }} /></div><button onClick={() => notify(user.plan === 'pro' ? 'Your Pro plan is active.' : 'Free includes two clients. Pro billing is not configured yet.')}>Plan details <span>↗</span></button></div><button className="profile" onClick={signOut}><div className="avatar avatar-coral">{(user.name || 'F').slice(0,1).toUpperCase()}</div><span><b>{user.name}</b><small>Sign out</small></span><span className="chevron">↗</span></button></div>
    </aside>
    <main className="main-area">
      <header className="topbar"><div className="breadcrumb"><span>{user.name}'s workspace</span><span className="slash">/</span><b>{page}</b></div><div className="top-actions"><div className="search-wrap"><label className="search global-search"><span>⌕</span><input ref={searchRef} placeholder="Search projects, clients, tasks…" value={search} onFocus={()=>setSearchOpen(true)} onBlur={()=>setTimeout(()=>setSearchOpen(false),120)} onChange={e => { setSearch(e.target.value); setSearchOpen(true); }} onKeyDown={e=>{if(e.key==='Enter'&&searchMatches[0])openSearchMatch(searchMatches[0]);if(e.key==='Escape')setSearchOpen(false);}}/><kbd>Ctrl K</kbd></label>{searchOpen&&search&&<div className="search-results">{searchMatches.length?searchMatches.map((match,i)=><button key={`${match.page}-${match.title}-${i}`} onMouseDown={e=>e.preventDefault()} onClick={()=>openSearchMatch(match)}><span className="result-glyph">{match.page==='Projects'?'▦':match.page==='Clients'?'◉':match.page==='Tasks'?'☷':match.page==='Invoices'?'▤':'◷'}</span><span><b>{match.title}</b><small>{match.detail}</small></span><kbd>↵</kbd></button>):<div className="search-empty">No matching records</div>}</div>}</div><button className="icon-button" title="Notifications" onClick={() => notify('You’re all caught up.')}>♧<i></i></button><div className="avatar avatar-coral top-avatar">{(user.name || 'F').slice(0,1).toUpperCase()}</div></div></header>
      <div className="page-content">
        {page === 'Overview' && <>
          <div className="welcome-row"><div><div className="eyebrow"><span className="live-dot"></span> {new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'}).toUpperCase()}</div><h1>A good week starts here<span className="period">.</span></h1><p className="subtitle">A clear view of what’s moving, what’s due, and what you’ve earned.</p></div><button className="button button-primary" onClick={() => setModal('quick')}><span>＋</span> New entry</button></div>
          <section className="metrics"><article className="metric"><div className="metric-label">Active projects</div><div className="metric-value">{String(dashboard?.stats.activeProjects ?? activeProjects.length).padStart(2, '0')}<span className="metric-note"> across {dashboard?.stats.clientCount ?? data.clients.length} clients</span></div></article><article className="metric"><div className="metric-label">Hours this week</div><div className="metric-value">{Number(dashboard?.stats.hoursWeek || 0).toFixed(1)}<span className="metric-unit">h</span></div><div className="metric-foot">Hours recorded since Monday</div></article><article className="metric"><div className="metric-label">Outstanding</div><div className="metric-value">{money(dashboard?.stats.outstanding ?? outstanding)}<span className="metric-change neutral">{dashboard?.stats.pendingCount ?? data.invoices.filter(i=>i.status!=='Paid').length} invoices</span></div><div className="metric-foot">{dashboard?.stats.overdueCount ?? data.invoices.filter(i=>i.status==='Overdue').length} past due</div></article><article className="metric"><div className="metric-label">Revenue this month</div><div className="metric-value">{money(dashboard?.stats.revenueMonth || 0)}</div><div className="metric-foot">Paid invoices issued this month</div></article></section>
          <section className="dashboard-grid"><div className="panel projects-panel"><div className="panel-header"><div><h2>Projects in motion</h2><p>The work on your desk right now</p></div><button className="text-link" onClick={() => setPage('Projects')}>All projects <span>↗</span></button></div><div className="project-table"><div className="table-head"><span>PROJECT</span><span>STATUS</span><span>DEADLINE</span><span>BUDGET USED</span></div>{activeProjects.slice(0, 4).map(p => <div className="project-row" key={p.id}><div className="project-cell"><i className="project-color" style={{ background: p.color }}></i><span><b>{p.name}</b><small>{clientName(p.clientId)}</small></span></div><div><span className="status-pill active"><i></i>{p.status}</span></div><div className="deadline">{day(p.due)}</div><div className="budget-cell"><div className="budget-text"><span>{Math.round(p.hours * 100 / (p.budget / (data.clients.find(c => c.id === p.clientId)?.rate || 100)))}%</span><small>{money(p.hours * (data.clients.find(c => c.id === p.clientId)?.rate || 100))}</small></div><div className="budget-track"><i style={{ width: `${Math.min(100, p.hours * (data.clients.find(c => c.id === p.clientId)?.rate || 100) / p.budget * 100)}%`, background: p.color }} /></div></div></div>)}</div><button className="panel-footer" onClick={() => setModal('project')}>＋ Add a project</button></div>
          <div className="right-stack"><div className="panel timer-panel"><div className="panel-header"><div><h2>Focus session</h2><p>Make time for what matters</p></div><span className="timer-mark">◷</span></div>{timer ? <><div className="timer-running"><span className="live-dot"></span> TIMER RUNNING</div><div className="timer-clock">{formatElapsed(now - timer.startedAt)}</div><div className="timer-project">{projectName(timer.projectId)}<small>{timer.note || 'Focused work'}</small></div><button className="button button-stop" onClick={closeTimer}>■ &nbsp; Stop timer</button></> : <><div className="timer-idle">00<span>:</span>00<span>:</span>00</div><p className="timer-hint">Start a timer and stay in your flow.</p><button className="button button-dark" onClick={() => setModal('timer')}>▶ &nbsp; Start timer</button></>}</div><div className="panel tasks-panel"><div className="panel-header"><div><h2>Up next</h2><p>A few things to keep in view</p></div><button className="round-plus" onClick={() => setModal('task')}>＋</button></div><div className="task-list">{data.tasks.filter(t => !t.done).slice(0, 3).map(t => <div className="task-row" key={t.id}><button className="check-circle" onClick={() => toggleTask(t)}></button><span className="task-copy"><b>{t.title}</b><small>{projectName(t.projectId)}</small></span><span className={`task-date ${t.due && t.due < new Date().toISOString().slice(0,10) ? 'late' : ''}`}>{t.due ? day(t.due) : 'No due date'}</span></div>)}</div><button className="panel-footer" onClick={() => setPage('Tasks')}>View all tasks <span>↗</span></button></div></div></section>
          <section className="lower-grid"><div className="panel hours-panel"><div className="panel-header"><div><h2>Your week, in hours</h2><p>Time logged across all projects</p></div><span className="range-label">This week</span></div><div className="chart"><div className="chart-guides"><span>8h</span><span>6h</span><span>4h</span><span>2h</span><span>0h</span></div><div className="chart-bars">{weekly.map((d, i) => <div className="chart-col" key={d.day}><div className="bar-zone"><i className={i === new Date().getDay() ? 'today' : ''} style={{ height: `${Math.min(100,d.value / 8 * 100)}%` }}></i></div><span>{d.day}</span></div>)}</div></div></div><div className="panel invoices-panel"><div className="panel-header"><div><h2>Recent invoices</h2><p>Keep the cash flow moving</p></div><button className="text-link" onClick={() => setPage('Invoices')}>View all <span>↗</span></button></div>{data.invoices.slice(0, 3).map(inv => <div className="invoice-row" key={inv.id}><span className="invoice-icon">▤</span><span className="invoice-copy"><b>{clientName(inv.clientId)}</b><small>{inv.number || inv.id} · Due {day(inv.due)}</small></span><span className="invoice-amount">{money(inv.amount)}</span><span className={`invoice-status ${inv.status.toLowerCase().replace(' ', '-')}`}>{inv.status}</span></div>)}</div></section>
          <div className="demo-note"><span>i</span> Your data is saved to your account and isolated from other users.{data.clients.length===0&&<button onClick={loadSampleData}>Load sample data</button>}</div>
        </>}
        {page === 'Projects' && <><PageHeading title="Projects" subtitle="The work, the people, and the progress behind it." action="＋ New project" onAction={() => setModal('project')} /><div className="toolbar"><label className="search local-search"><span>⌕</span><input placeholder="Find a project" value={search} onChange={e=>setSearch(e.target.value)}/></label><select value={filter} onChange={e=>setFilter(e.target.value)}><option>All projects</option><option>In progress</option><option>Completed</option></select></div><div className="panel full-table"><div className="table-head project-list-head"><span>PROJECT</span><span>CLIENT</span><span>STATUS</span><span>DUE DATE</span><span>BUDGET</span><span>SPENT</span></div>{data.projects.filter(p => (filter === 'All projects' || filter === p.status || filter === p.name) && `${p.name} ${clientName(p.clientId)}`.toLowerCase().includes(search.toLowerCase())).map(p=><div className="project-row project-list-row" key={p.id}><div className="project-cell"><i className="project-color" style={{background:p.color}}/><span><b>{p.name}</b><small>{p.hours}h logged</small></span><div className="record-actions"><button type="button" onClick={()=>beginEdit('projects',p)}>Edit</button><button type="button" onClick={()=>deleteRecord('projects',p)}>Delete</button></div></div><span>{clientName(p.clientId)}</span><span className={`status-pill ${p.status === 'Completed' ? 'complete' : 'active'}`}><i></i>{p.status}</span><span>{day(p.due)}</span><span>{money(p.budget)}</span><b>{money(p.hours * (data.clients.find(c=>c.id===p.clientId)?.rate || 100))}</b></div>)}</div><div className="demo-note"><span>i</span> Project records are saved to your account.</div></>}
        {page === 'Clients' && <><PageHeading title="Clients" subtitle="Good work starts with good relationships." action={search.trim() ? null : '＋ Add client'} onAction={() => setModal('client')} /><div className="toolbar"><label className="search local-search"><span>⌕</span><input placeholder="Find a client" value={search} onChange={e=>setSearch(e.target.value)}/></label><span className="result-count">{search.trim() ? `${filteredClients.length} found` : `${data.clients.length} clients`}</span></div>{filteredClients.length ? <div className="client-grid">{filteredClients.map(c=><article className="panel client-card" key={c.id}><div className="client-card-top"><div className="client-avatar" style={{background:c.color}}>{c.name.split(' ').map(x=>x[0]).slice(0,2).join('')}</div><div className="record-actions"><button type="button" onClick={()=>beginEdit('clients',c)}>Edit</button><button type="button" onClick={()=>deleteRecord('clients',c)}>Delete</button></div></div><h2>{c.name}</h2><p>{c.contact} · {c.email}</p><div className="client-card-bottom"><span>Default hourly rate</span><b>{money(c.rate)}<small>/hr</small></b></div><div className="client-card-bottom"><span>Active projects</span><b>{data.projects.filter(p=>p.clientId===c.id && p.status==='In progress').length}</b></div></article>)}{!search.trim()&&<button className="add-client-card" onClick={()=>setModal('client')}><span>＋</span><b>Add a client</b><small>Bring a new partnership into your workspace</small></button>}</div> : <div className="empty-clients" role="status"><span className="empty-client-icon">⌕</span><h2>{search.trim() ? `No existing clients named “${search.trim()}”` : 'No clients yet'}</h2><p>{search.trim() ? 'You can create one if this is a new client.' : 'Add your first client, or load a sample workspace from the dashboard.'}</p><button className="button button-primary" onClick={() => setModal('client')}>＋ New client</button></div>}<div className="demo-note"><span>i</span> Your client records are saved to your account.</div></>}
        {page === 'Tasks' && <><PageHeading title="Tasks" subtitle="Small next steps make the big work happen." action="＋ Add task" onAction={()=>setModal('task')} /><div className="panel tasks-page">{['To do','Completed'].map(status=><section key={status}><div className="task-section-head">{status}<span>{data.tasks.filter(t=>t.done===(status==='Completed')).length}</span></div>{data.tasks.filter(t=>t.done===(status==='Completed')).map(t=><div className="task-row task-page-row" key={t.id}><button className={`check-circle ${t.done?'checked':''}`} onClick={()=>toggleTask(t)}>{t.done?'✓':''}</button><span className="task-copy"><b className={t.done?'struck':''}>{t.title}</b><small>{projectName(t.projectId)}</small></span><span className="task-date">{t.due?`Due ${day(t.due)}`:'No due date'}</span><div className="record-actions"><button type="button" onClick={()=>beginEdit('tasks',t)}>Edit</button><button type="button" onClick={()=>deleteRecord('tasks',t)}>Delete</button></div></div>)}</section>)}</div></>}
        {page === 'Time' && <><PageHeading title="Time" subtitle="Know where your working hours go." action={timer?'■ Stop timer':'▶ Start timer'} onAction={()=>timer?closeTimer():setModal('timer')} /><div className="time-summary"><div className="panel"><span>This week</span><b>{hoursWeek.toFixed(1)}h</b><small>Across {new Set(data.entries.map(e=>e.projectId)).size} projects</small></div><div className="panel"><span>This month</span><b>{hoursMonth.toFixed(1)}h</b><small>Time recorded this month</small></div><div className="panel"><span>Unbilled</span><b>{money(unbilledAmount)}</b><small>Ready to invoice</small></div></div><div className="panel entries-panel"><div className="panel-header"><div><h2>Time entries</h2><p>Recent work, recorded as it happened</p></div><button className="button button-secondary" onClick={()=>setModal('quick')}>＋ Manual entry</button></div>{data.entries.map(e=><div className="entry-row" key={e.id}><span className="entry-date">{day(e.date)}</span><span className="entry-copy"><b>{e.note}</b><small>{projectName(e.projectId)} · {clientName(data.projects.find(p=>p.id===e.projectId)?.clientId)}</small></span><b>{e.hours}h</b>{e.invoiceId?<span className="entry-billed">Invoiced</span>:<div className="record-actions"><button type="button" onClick={()=>beginEdit('entries',e)}>Edit</button><button type="button" onClick={()=>deleteRecord('entries',e)}>Delete</button></div>}</div>)}</div></>}
        {page === 'Invoices' && <><PageHeading title="Invoices" subtitle="Clear, professional billing for work well done." action="＋ New invoice" onAction={()=>setModal('invoice')} /><div className="time-summary invoice-summary"><div className="panel"><span>Outstanding</span><b>{money(outstanding)}</b><small>{data.invoices.filter(i=>i.status!=='Paid').length} awaiting payment</small></div><div className="panel"><span>Paid this year</span><b>{money(paidYear)}</b><small>{data.invoices.filter(i=>i.status==='Paid').length} invoice paid</small></div><div className="panel"><span>Overdue</span><b>{money(data.invoices.filter(i=>i.status==='Overdue').reduce((s,i)=>s+i.amount,0))}</b><small>Follow up when you’re ready</small></div></div><div className="panel invoice-list"><div className="list-title"><h2>All invoices</h2><span>{data.invoices.length} total</span></div>{data.invoices.map(inv=><div className="invoice-row" key={inv.id}><span className="invoice-icon">▤</span><span className="invoice-copy"><b>{clientName(inv.clientId)}</b><small>{inv.number || inv.id} · Issued {day(inv.date)} · Due {day(inv.due)}</small></span><span className="invoice-amount">{money(inv.amount)}</span><span className={`invoice-status ${inv.status.toLowerCase().replace(' ', '-')}`}>{inv.status}</span><button className="text-link" onClick={()=>downloadInvoice(inv)}>PDF ↗</button><button className="text-link" onClick={()=>markInvoicePaid(inv)}>{inv.status==='Paid'?'Reopen':'Mark paid'}</button></div>)}</div></>}
        {page === 'Reports' && <><PageHeading title="Reports" subtitle="The numbers behind a sustainable independent practice." action="Export report" onAction={()=>window.print()} /><div className="time-summary"><div className="panel"><span>Revenue this month</span><b>{money(reportData?.summary.revenueMonth||0)}</b><small>Paid invoices issued this month</small></div><div className="panel"><span>Outstanding</span><b>{money(reportData?.summary.outstanding??outstanding)}</b><small>Across open invoices</small></div><div className="panel"><span>Billable hours</span><b>{Number(reportData?.summary.hoursMonth||0).toFixed(1)}h</b><small>Logged this month</small></div></div><div className="panel hours-panel report-chart"><div className="panel-header"><div><h2>Revenue over time</h2><p>Monthly paid invoices, in USD</p></div><span className="range-label">Last 6 months</span></div><div className="chart"><div className="chart-guides"><span>{money(reportMax)}</span><span>{money(reportMax*.75)}</span><span>{money(reportMax*.5)}</span><span>{money(reportMax*.25)}</span><span>$0</span></div><div className="chart-bars">{reportMonths.map((item,i)=><div className="chart-col" key={`${item.month}-${i}`}><div className="bar-zone"><i className={i===reportMonths.length-1?'today':''} style={{height:`${Math.max(item.revenue?2:0,item.revenue/reportMax*100)}%`}}/></div><span>{item.month}</span></div>)}</div></div></div><div className="panel full-table"><div className="list-title"><h2>Project budget health</h2><span>Tracked against project budgets</span></div>{(reportData?.budgets||[]).map(p=><div className="project-row report-project" key={p.id}><div className="project-cell"><i className="project-color" style={{background:p.color}}/><span><b>{p.name}</b><small>{clientName(p.clientId)}</small></span></div><div className="budget-cell"><div className="budget-text"><span>{p.budget?Math.round(p.hours*(data.clients.find(c=>c.id===p.clientId)?.rate||100)/p.budget*100):0}% used</span><small>{money(p.budget)}</small></div><div className="budget-track"><i style={{width:`${p.budget?Math.min(100,p.hours*(data.clients.find(c=>c.id===p.clientId)?.rate||100)/p.budget*100):0}%`,background:p.color}}/></div></div></div>)}</div></>}
      </div>
    </main>
    {modal && <Modal type={modal} data={data} editing={editing} onClose={closeModal} onAdd={addRecord} onUpdate={updateRecord} onStart={startTimer} onEntry={saveTimeEntry} onInvoice={createInvoice} />}
    {toast && <div className="toast"><span>✓</span>{toast}</div>}
  </div>;
}
function formatElapsed(ms) { const total=Math.floor(ms/1000), h=String(Math.floor(total/3600)).padStart(2,'0'), m=String(Math.floor(total%3600/60)).padStart(2,'0'), s=String(total%60).padStart(2,'0'); return `${h}:${m}:${s}`; }
function PageHeading({title,subtitle,action,onAction}) { return <div className="welcome-row page-heading"><div><div className="eyebrow">STUDIO SANTh <span className="slash">/</span> WORKSPACE</div><h1>{title}<span className="period">.</span></h1><p className="subtitle">{subtitle}</p></div>{action&&<button className="button button-primary" onClick={onAction}>{action}</button>}</div>; }
function Modal({type,data,editing,onClose,onAdd,onUpdate,onStart,onEntry,onInvoice}) {
  const [form,setForm]=useState(()=>{if(editing)return{...editing.record};if(type!=='invoice')return{};const now=new Date();const start=new Date(now);start.setDate(start.getDate()-((start.getDay()+6)%7));const due=new Date(now);due.setDate(due.getDate()+14);const key=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;return{startDate:key(start),endDate:key(now),dueDate:key(due)}}); const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  const projects=data.projects, clients=data.clients;
  const title=editing?`Edit ${editing.kind==='entries'?'time entry':editing.kind.slice(0,-1)}`:({client:'A new client',project:'A new project',task:'Add a task',timer:'Start a focus session',quick:'Log your time',invoice:'Create an invoice'}[type]||'New entry');
  const field=(label,key,placeholder='',kind='text',extra={})=><label className="form-field"><span>{label}</span><input type={kind} placeholder={placeholder} value={form[key]||''} onChange={e=>set(key,e.target.value)} required={['name','title','budget','hours','amount','startDate','endDate','dueDate'].includes(key)} min={kind==='number'?'0.01':undefined} {...extra}/></label>;
  const projectSelect=<label className="form-field"><span>Project</span><select required value={form.projectId||projects[0]?.id||''} onChange={e=>set('projectId',e.target.value)}>{projects.map(p=><option value={p.id} key={p.id}>{p.name}</option>)}</select></label>;
  const clientSelect=<label className="form-field"><span>Client</span><select required value={form.clientId||clients[0]?.id||''} onChange={e=>set('clientId',e.target.value)}>{clients.map(c=><option value={c.id} key={c.id}>{c.name}</option>)}</select></label>;
  let content;
  if(type==='client') content=<>{field('CLIENT NAME','name','e.g. Studio North')}{field('CONTACT PERSON','contact','e.g. Maya Chen')}{field('EMAIL ADDRESS','email','name@company.com','email')}{field('DEFAULT HOURLY RATE','rate','120','number')}</>;
  if(type==='project') content=<>{field('PROJECT NAME','name','e.g. Website redesign')}{clientSelect}{field('BUDGET','budget','8,000','number')}<label className="form-field"><span>STATUS</span><select value={form.status||'In progress'} onChange={e=>set('status',e.target.value)}><option>In progress</option><option>On hold</option><option>Completed</option></select></label>{field('DUE DATE','due','','date')}</>;
  if(type==='task') content=<>{field('TASK','title','What needs to get done?')}{projectSelect}{field('DUE DATE','due','','date')}</>;
  if(type==='timer') content=<>{projectSelect}{field('WHAT ARE YOU WORKING ON?','note','e.g. Design exploration')}</>;
  if(type==='quick') content=<>{projectSelect}{field('DESCRIPTION','note','What did you work on?')}{field('DATE','date',new Date().toISOString().slice(0,10),'date')}{field('HOURS','hours','2.5','number',{step:'0.25',min:'0.1'})}</>;
  if(type==='invoice') content=<>{clientSelect}{field('FROM DATE','startDate','','date')}{field('THROUGH DATE','endDate','','date')}{field('PAYMENT DUE','dueDate','','date')}<p className="form-hint">The total is calculated from this client’s unbilled time entries in the selected range.</p></>;
  const submit=e=>{e.preventDefault(); if(editing){onUpdate(editing.kind,editing.record.id,form);return;} if(type==='client')onAdd('clients',{...form,rate:Number(form.rate)||100,color:['#b9c6b0','#e8c9ad','#d8cce8'][clients.length%3]}); if(type==='project')onAdd('projects',{...form,clientId:form.clientId,budget:Number(form.budget)||0,hours:0,status:form.status||'In progress',color:['#aab7a0','#d5a982','#b8a6cf'][projects.length%3]}); if(type==='task')onAdd('tasks',{...form,projectId:form.projectId,done:false}); if(type==='timer')onStart({...form,projectId:form.projectId}); if(type==='quick')onEntry({...form,projectId:form.projectId,hours:Number(form.hours),date:form.date||new Date().toISOString().slice(0,10)}); if(type==='invoice')onInvoice({...form,clientId:form.clientId}); };
  return <div className="modal-backdrop" onMouseDown={e=>e.target===e.currentTarget&&onClose()}><form className="modal" onSubmit={submit}><div className="modal-head"><div><div className="eyebrow">STUDIO SANTh · WORKSPACE</div><h2>{title}</h2></div><button type="button" className="modal-close" onClick={onClose}>×</button></div><div className="modal-fields">{content}</div><div className="modal-actions"><button className="button button-secondary" type="button" onClick={onClose}>Cancel</button><button className="button button-primary" type="submit">{type==='timer'?'Start timer':type==='quick'?'Save entry':type==='invoice'?'Create invoice':'Save'}</button></div></form></div>;
}

function AuthScreen({ apiAvailable, onAuthenticated }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const submit = async event => {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      const response = await api(`/auth/${mode === 'login' ? 'login' : 'register'}`, { method: 'POST', body: form });
      onAuthenticated(response.user);
    } catch (requestError) { setError(requestError.message); }
    finally { setBusy(false); }
  };
  return <div className="auth-screen"><div className="auth-card"><div className="brand"><div className="brand-mark"><span></span><span></span><span></span></div><span>freelance<span className="brand-light">flow</span></span></div><div className="auth-intro"><p className="eyebrow">YOUR INDEPENDENT WORKSPACE</p><h1>{mode === 'login' ? 'Welcome back.' : 'Make room for good work.'}</h1><p>{mode === 'login' ? 'Sign in to pick up where your work left off.' : 'Create an account to organize clients, projects, and time.'}</p></div>{!apiAvailable&&<div className="auth-api-error"><b>API is not reachable yet.</b><span>Start PostgreSQL and the FreelanceFlow API, then reload this page.</span></div>}{error&&<div className="auth-error" role="alert">{error}</div>}<form className="auth-form" onSubmit={submit}>{mode==='register'&&<label className="form-field"><span>YOUR NAME</span><input autoComplete="name" required maxLength="80" value={form.name} onChange={e=>set('name',e.target.value)} /></label>}<label className="form-field"><span>EMAIL ADDRESS</span><input type="email" autoComplete="email" required value={form.email} onChange={e=>set('email',e.target.value)} /></label><label className="form-field"><span>PASSWORD</span><input type="password" autoComplete={mode==='login'?'current-password':'new-password'} minLength="10" required value={form.password} onChange={e=>set('password',e.target.value)} /></label><button className="button button-primary auth-submit" type="submit" disabled={busy||!apiAvailable}>{busy?'Please wait…':mode==='login'?'Sign in':'Create account'}</button></form><p className="auth-switch">{mode==='login'?"New to FreelanceFlow?":"Already have an account?"} <button onClick={()=>{setMode(mode==='login'?'register':'login');setError('');}}> {mode==='login'?'Create an account':'Sign in'}</button></p><p className="auth-note">Your workspace data is stored in your account and isolated from other users.</p></div></div>;
}

createRoot(document.getElementById('root')).render(<App />);
