import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { useAuth, homePathFor, FARM_SIDE_ROLES } from './context/AuthContext.jsx';
import { Loading, EmptyState } from './components/ui.jsx';
import { useFarm } from './context/FarmContext.jsx';
import AppShell from './layouts/AppShell.jsx';
import StatusPage from './components/StatusPage.jsx';
import StatusCodes from './pages/status/StatusCodes.jsx';
import Login from './pages/auth/Login.jsx';
import Register from './pages/auth/Register.jsx';
import Landing from './pages/public/Landing.jsx';
import FarmOverview from './pages/farm/Overview.jsx';
import Harvests from './pages/farm/Harvests.jsx';
import HarvestDetail from './pages/farm/HarvestDetail.jsx';
import Demand from './pages/farm/Demand.jsx';
import HarvestMatch from './pages/farm/HarvestMatch.jsx';
import MarketRoute from './pages/farm/MarketRoute.jsx';
import FarmOrders from './pages/farm/Orders.jsx';
import Recovery from './pages/farm/Recovery.jsx';
import Rescue from './pages/farm/Rescue.jsx';
import Campaigns from './pages/farm/Campaigns.jsx';
import Analytics from './pages/farm/Analytics.jsx';
import Settings from './pages/farm/Settings.jsx';
import BuyerDashboard from './pages/buyer/Dashboard.jsx';
import AvailableSupply from './pages/buyer/AvailableSupply.jsx';
import MyDemand from './pages/buyer/MyDemand.jsx';
import BuyerMatches from './pages/buyer/Matches.jsx';
import MyOrders from './pages/buyer/MyOrders.jsx';
import Profile from './pages/buyer/Profile.jsx';
import ConsumerHome from './pages/consumer/Home.jsx';
import AvailableNow from './pages/consumer/AvailableNow.jsx';
import GrowingSoon from './pages/consumer/GrowingSoon.jsx';
import RescueMarket from './pages/consumer/RescueMarket.jsx';
import CommunityDrops from './pages/consumer/CommunityDrops.jsx';
import MyInterests from './pages/consumer/MyInterests.jsx';
import AdminFarms from './pages/admin/Farms.jsx';
import AdminUsers from './pages/admin/Users.jsx';
import AdminPolicies from './pages/admin/Policies.jsx';
import AdminDisputes from './pages/admin/Disputes.jsx';
import AdminAuditLog from './pages/admin/AuditLog.jsx';
import FarmPool from './pages/farm/FarmPool.jsx';
import DemandPool from './pages/farm/DemandPool.jsx';
import FarmDirectory from './pages/market/FarmDirectory.jsx';
import FarmProfile from './pages/market/FarmProfile.jsx';
import Shop from './pages/consumer/Shop.jsx';
import ShopManager from './pages/farm/ShopManager.jsx';
import BuyerGrowth from './pages/farm/BuyerGrowth.jsx';

/** Client-side route guard for UX only — the API enforces every permission server-side. */
function RequireRole({ roles, children }) {
  const { user, loading } = useAuth();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) return <StatusPage inline code={403} detail="This area is for a different account type." />;
  return children;
}

/** FarmPool / DemandPool are Post-MVP (proposal v3 Phase 3): shown only when the platform preview is enabled. */
function RequireNetworkPreview({ children }) {
  const { features } = useFarm();
  if (!features.networkFeaturesEnabled) {
    return (
      <EmptyState title="Phase 3 network preview">
        FarmPool and DemandPool are planned for Phase 3 (network expansion), after the ComCrop MVP is validated. A platform admin can enable the preview in Policies.
      </EmptyState>
    );
  }
  return children;
}

/** /status/:code — design preview of the page for any HTTP status code. */
function StatusCodeRoute() {
  const { code } = useParams();
  return <StatusPage code={/^\d{3}$/.test(code) ? Number(code) : 404} />;
}

const FARM_ADMINS = ['platform_admin', 'farm_admin'];
const BUYERS = ['business_buyer'];
const CONSUMERS = ['consumer'];

export default function App() {
  const { user, loading } = useAuth();
  if (loading) return <Loading label="Starting Tyllage…" />;

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to={homePathFor(user)} replace /> : <Login />} />
      <Route path="/shop/:farmId" element={<main className="public-shop"><Shop /></main>} />
      <Route path="/status" element={<StatusCodes />} />
      <Route path="/status/:code" element={<StatusCodeRoute />} />
      {/* Public website for visitors; signed-in users go straight to their workspace. */}
      <Route path="/" element={user ? <Navigate to={homePathFor(user)} replace /> : <Landing />} />
      <Route path="/register" element={user ? <Navigate to={homePathFor(user)} replace /> : <Register />} />

      <Route element={<RequireRole><AppShell /></RequireRole>}>
        <Route path="/farm/overview" element={<RequireRole roles={FARM_SIDE_ROLES}><FarmOverview /></RequireRole>} />
        <Route path="/farm/harvests" element={<RequireRole roles={FARM_SIDE_ROLES}><Harvests /></RequireRole>} />
        <Route path="/farm/harvests/:id" element={<RequireRole roles={FARM_SIDE_ROLES}><HarvestDetail /></RequireRole>} />
        <Route path="/farm/demand" element={<RequireRole roles={FARM_SIDE_ROLES}><Demand /></RequireRole>} />
        <Route path="/farm/marketroute" element={<RequireRole roles={FARM_SIDE_ROLES}><MarketRoute /></RequireRole>} />
        <Route path="/farm/harvestmatch" element={<RequireRole roles={FARM_ADMINS}><HarvestMatch /></RequireRole>} />
        <Route path="/farm/orders" element={<RequireRole roles={FARM_SIDE_ROLES}><FarmOrders /></RequireRole>} />
        <Route path="/farm/shop" element={<RequireRole roles={FARM_ADMINS}><ShopManager /></RequireRole>} />
        <Route path="/farm/buyers" element={<RequireRole roles={FARM_ADMINS}><BuyerGrowth /></RequireRole>} />
        <Route path="/farm/recovery" element={<RequireRole roles={FARM_ADMINS}><Recovery /></RequireRole>} />
        <Route path="/farm/rescue" element={<RequireRole roles={FARM_SIDE_ROLES}><Rescue /></RequireRole>} />
        <Route path="/farm/campaigns" element={<RequireRole roles={FARM_ADMINS}><Campaigns /></RequireRole>} />
        <Route path="/farm/analytics" element={<RequireRole roles={FARM_ADMINS}><Analytics /></RequireRole>} />
        <Route path="/farm/settings" element={<RequireRole roles={FARM_SIDE_ROLES}><Settings /></RequireRole>} />

        <Route path="/admin/farms" element={<RequireRole roles={['platform_admin']}><AdminFarms /></RequireRole>} />
        <Route path="/admin/users" element={<RequireRole roles={['platform_admin']}><AdminUsers /></RequireRole>} />
        <Route path="/admin/policies" element={<RequireRole roles={['platform_admin']}><AdminPolicies /></RequireRole>} />
        <Route path="/admin/disputes" element={<RequireRole roles={['platform_admin']}><AdminDisputes /></RequireRole>} />
        <Route path="/admin/audit" element={<RequireRole roles={['platform_admin']}><AdminAuditLog /></RequireRole>} />

        <Route path="/farm/farmpool" element={<RequireRole roles={FARM_ADMINS}><RequireNetworkPreview><FarmPool /></RequireNetworkPreview></RequireRole>} />
        <Route path="/farm/demandpool" element={<RequireRole roles={FARM_ADMINS}><RequireNetworkPreview><DemandPool /></RequireNetworkPreview></RequireRole>} />

        <Route path="/market/farms" element={<RequireRole roles={[...BUYERS, ...CONSUMERS]}><FarmDirectory /></RequireRole>} />
        <Route path="/market/farms/:id" element={<RequireRole roles={[...BUYERS, ...CONSUMERS]}><FarmProfile /></RequireRole>} />

        <Route path="/buyer/dashboard" element={<RequireRole roles={BUYERS}><BuyerDashboard /></RequireRole>} />
        <Route path="/buyer/supply" element={<RequireRole roles={BUYERS}><AvailableSupply /></RequireRole>} />
        <Route path="/buyer/demand" element={<RequireRole roles={BUYERS}><MyDemand /></RequireRole>} />
        <Route path="/buyer/matches" element={<RequireRole roles={BUYERS}><BuyerMatches /></RequireRole>} />
        <Route path="/buyer/orders" element={<RequireRole roles={BUYERS}><MyOrders /></RequireRole>} />
        <Route path="/buyer/profile" element={<RequireRole roles={BUYERS}><Profile /></RequireRole>} />

        <Route path="/consumer" element={<RequireRole roles={CONSUMERS}><ConsumerHome /></RequireRole>} />
        <Route path="/consumer/shop" element={<RequireRole roles={CONSUMERS}><Shop /></RequireRole>} />
        <Route path="/consumer/shop/:farmId" element={<RequireRole roles={CONSUMERS}><Shop /></RequireRole>} />
        <Route path="/consumer/available" element={<RequireRole roles={CONSUMERS}><AvailableNow /></RequireRole>} />
        <Route path="/consumer/growing" element={<RequireRole roles={CONSUMERS}><GrowingSoon /></RequireRole>} />
        <Route path="/consumer/rescue" element={<RequireRole roles={CONSUMERS}><RescueMarket /></RequireRole>} />
        <Route path="/consumer/drops" element={<RequireRole roles={CONSUMERS}><CommunityDrops /></RequireRole>} />
        <Route path="/consumer/orders" element={<RequireRole roles={CONSUMERS}><MyOrders /></RequireRole>} />
        <Route path="/consumer/interests" element={<RequireRole roles={CONSUMERS}><MyInterests /></RequireRole>} />
      </Route>

      <Route path="*" element={<StatusPage code={404} />} />
    </Routes>
  );
}
