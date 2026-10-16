import { Link } from 'react-router-dom';
import { Logo, Wordmark } from '../components/Icons.jsx';

// Proposal v3 core workflow.
const LOOP = ['Record expected harvest', 'Capture demand & coverage', 'Compare routes with MarketRoute', 'HarvestMatch within the route', 'Farmer approves allocation', 'Demand Recovery & Rescue', 'Insights'];

export default function AuthLayout({ children }) {
  return (
    <div className="auth-page">
      <aside className="auth-side">
        <div>
          <Link to="/" className="auth-brand" aria-label="Tyllage website">
            <Logo size={36} />
            <div>
              <div className="auth-brand-name">Tyllage</div>
              <div className="auth-brand-tag">From Harvest to Demand.</div>
            </div>
          </Link>
          <h1>Decide where upcoming harvest should go — before it becomes a commercial problem.</h1>
          <div className="loop">
            {LOOP.map((step, i) => (
              <div key={step}>
                <b>{i + 1}</b>
                {step}
              </div>
            ))}
          </div>
        </div>
        <div style={{ fontSize: 12, color: '#7f978a' }}>
          Demand &amp; market access platform for local farms: commercial intelligence, market coordination and demand recovery. Industry-wide opportunity, ComCrop-first validation.
        </div>
      </aside>
      <main className="auth-main">
        <div className="auth-card">
          <Link to="/" className="small auth-back">← Back to the Tyllage website</Link>
          {/* The side panel (with the logo) is hidden on phones, so the form shows the wordmark there instead. */}
          <div className="auth-logo auth-mobile-logo"><Wordmark height={44} /></div>
          {children}
        </div>
      </main>
    </div>
  );
}
