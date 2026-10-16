import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { useFarm } from '../context/FarmContext.jsx';
import { Icons, Logo } from '../components/Icons.jsx';
import { api } from '../services/api.js';
import { dateTime, label } from '../utils/format.js';

// Follows the proposal v3 workflow: harvest → demand → route → match → orders → recovery → learn.
const FARM_NAV = [
  { to: '/farm/overview', label: 'Demand Radar', icon: Icons.Overview },
  { to: '/farm/harvests', label: 'Harvests', icon: Icons.Harvest },
  { to: '/farm/demand', label: 'Demand', icon: Icons.Demand },
  { to: '/farm/marketroute', label: 'MarketRoute', icon: Icons.Route },
  { to: '/farm/harvestmatch', label: 'HarvestMatch', icon: Icons.Match, admin: true },
  { to: '/farm/orders', label: 'Orders', icon: Icons.Orders },
  { to: '/farm/shop', label: 'Tyllage Shop', icon: Icons.Supply, admin: true },
  { to: '/farm/buyers', label: 'Buyer Growth', icon: Icons.Users, admin: true },
  { to: '/farm/recovery', label: 'Recovery', icon: Icons.Recovery, admin: true },
  { to: '/farm/rescue', label: 'Rescue', icon: Icons.Rescue },
  { to: '/farm/campaigns', label: 'Connect', icon: Icons.Campaign, admin: true },
  { to: '/farm/analytics', label: 'Insights', icon: Icons.Analytics, admin: true },
  { to: '/farm/settings', label: 'Settings', icon: Icons.Settings },
];
const NETWORK_NAV = [
  { to: '/farm/farmpool', label: 'FarmPool', icon: Icons.Farm },
  { to: '/farm/demandpool', label: 'DemandPool', icon: Icons.Users },
];
const ADMIN_NAV = [
  { to: '/admin/farms', label: 'Farms', icon: Icons.Farm },
  { to: '/admin/users', label: 'Users', icon: Icons.Users },
  { to: '/admin/policies', label: 'Policies', icon: Icons.Settings },
  { to: '/admin/disputes', label: 'Disputes', icon: Icons.Alert },
  { to: '/admin/audit', label: 'Audit log', icon: Icons.Orders },
  { to: '/status', label: 'API status codes', icon: Icons.Analytics },
];
const BUYER_NAV = [
  { to: '/buyer/dashboard', label: 'Dashboard', icon: Icons.Overview },
  { to: '/buyer/supply', label: 'Available Supply', icon: Icons.Supply },
  { to: '/market/farms', label: 'Farms', icon: Icons.Farm },
  { to: '/buyer/demand', label: 'My Demand', icon: Icons.Demand },
  { to: '/buyer/matches', label: 'Matches', icon: Icons.Match },
  { to: '/buyer/orders', label: 'Orders', icon: Icons.Orders },
  { to: '/buyer/profile', label: 'Profile', icon: Icons.User },
];
const CONSUMER_NAV = [
  { to: '/consumer', label: 'Home', icon: Icons.Home, end: true },
  { to: '/consumer/shop', label: 'Tyllage Shop', icon: Icons.Supply },
  { to: '/consumer/available', label: 'Available Now', icon: Icons.Supply },
  { to: '/consumer/growing', label: 'Growing Soon', icon: Icons.Sprout },
  { to: '/market/farms', label: 'Farms', icon: Icons.Farm },
  { to: '/consumer/rescue', label: 'Rescue', icon: Icons.Rescue },
  { to: '/consumer/drops', label: 'Community Drops', icon: Icons.Pin },
  { to: '/consumer/orders', label: 'My Orders', icon: Icons.Orders },
  { to: '/consumer/interests', label: 'My Interests', icon: Icons.Heart },
];

function NavItems({ items }) {
  return items.map((item) => (
    <NavLink key={item.to} to={item.to} end={item.end}>
      <item.icon />
      {item.label}
    </NavLink>
  ));
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const load = () => api.get('/notifications').then(setItems).catch(() => {});
  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, []);
  const unread = items.filter((n) => n.status !== 'READ').length;
  const markRead = async (n) => {
    if (n.status === 'READ') return;
    await api.post(`/notifications/${n.id}/read`).catch(() => {});
    setItems((list) => list.map((x) => (x.id === n.id ? { ...x, status: 'READ' } : x)));
  };
  return (
    <div style={{ position: 'relative' }}>
      <button className="btn btn-ghost btn-sm" onClick={() => setOpen((o) => !o)} aria-label={`Notifications (${unread} unread)`}>
        <Icons.Bell />
        {unread > 0 && <span className="badge badge-high">{unread}</span>}
      </button>
      {open && (
        <div className="card" style={{ position: 'absolute', right: 0, top: 40, width: 340, maxHeight: 420, overflowY: 'auto', zIndex: 40, boxShadow: 'var(--shadow-lg)' }}>
          <div className="card-header"><h3>Notifications</h3></div>
          {items.length === 0 && <div className="empty small">No notifications yet</div>}
          {items.map((n) => (
            <div key={n.id} onClick={() => markRead(n)} style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', cursor: 'pointer', background: n.status === 'READ' ? 'transparent' : 'var(--primary-soft)' }}>
              <div className="strong small">{n.title}</div>
              <div className="small muted">{n.body}</div>
              <div className="small muted">{dateTime(n.createdAt)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function AppShell() {
  const { user, logout, isFarmSide, isFarmAdmin, isPlatformAdmin } = useAuth();
  const { farms, farm, farmId, setActiveFarmId, features } = useFarm();
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => setMenuOpen(false), [location.pathname]);

  const initials = user.fullName.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();

  return (
    <div className="app">
      <div className={`sidebar-overlay ${menuOpen ? 'open' : ''}`} onClick={() => setMenuOpen(false)} />
      <aside className={`sidebar ${menuOpen ? 'open' : ''}`}>
        <NavLink to="/" className="brand">
          <Logo />
          <div>
            <div className="brand-name">Tyllage</div>
            <div className="brand-tag">From Harvest to Demand</div>
          </div>
        </NavLink>
        <nav className="nav" aria-label="Main">
          {isFarmSide && (
            <>
              <div className="nav-section">Farm</div>
              <NavItems items={FARM_NAV.filter((i) => !i.admin || isFarmAdmin)} />
              {isFarmAdmin && features.networkFeaturesEnabled && (
                <>
                  <div className="nav-section">Network · Phase 3 preview</div>
                  <NavItems items={NETWORK_NAV} />
                </>
              )}
            </>
          )}
          {isPlatformAdmin && (
            <>
              <div className="nav-section">Platform</div>
              <NavItems items={ADMIN_NAV} />
            </>
          )}
          {user.role === 'business_buyer' && <NavItems items={BUYER_NAV} />}
          {user.role === 'consumer' && <NavItems items={CONSUMER_NAV} />}
        </nav>
        <div className="sidebar-foot">ComCrop-first pilot · multi-farm ready</div>
      </aside>

      <div className="main">
        <header className="topbar">
          <button className="btn btn-ghost btn-sm menu-btn" onClick={() => setMenuOpen(true)} aria-label="Open menu">
            <Icons.Menu />
          </button>
          {isFarmSide && farms.length > 1 ? (
            <select className="input" style={{ maxWidth: 300 }} value={farmId || ''} onChange={(e) => setActiveFarmId(Number(e.target.value))} aria-label="Active farm">
              {farms.map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
          ) : (
            isFarmSide && farm && <div className="strong">{farm.name}</div>
          )}
          <div className="topbar-spacer" />
          <Notifications />
          <div className="user-chip">
            <div className="avatar">{initials}</div>
            <div className="user-meta">
              <div className="name">{user.fullName}</div>
              <div className="role">{label(user.role)}</div>
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => { logout(); navigate('/login'); }} aria-label="Sign out" title="Sign out">
            <Icons.Logout />
          </button>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
