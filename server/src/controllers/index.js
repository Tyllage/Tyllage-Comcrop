/**
 * Thin HTTP controllers: parse params, call a service, shape the response.
 * Business rules and authorisation checks on loaded records live in services.
 */
import { ok, created } from '../utils/response.js';
import { idParam } from '../utils/validate.js';
import * as auth from '../services/authService.js';
import * as farms from '../services/farmService.js';
import * as produce from '../services/produceService.js';
import * as harvests from '../services/harvestService.js';
import * as buyers from '../services/buyerService.js';
import * as demand from '../services/demandService.js';
import * as harvestMatch from '../services/harvestMatchService.js';
import * as matches from '../services/matchService.js';
import * as orders from '../services/orderService.js';
import * as recovery from '../services/recoveryService.js';
import * as rescue from '../services/rescueService.js';
import * as campaigns from '../services/campaignService.js';
import * as analytics from '../services/analyticsService.js';
import * as dashboard from '../services/dashboardService.js';
import * as drops from '../services/communityDropService.js';
import * as marketplace from '../services/marketplaceService.js';
import * as notifications from '../services/notificationService.js';
import * as audit from '../services/auditService.js';
import * as users from '../services/userService.js';
import { verifyWebhook } from '../services/whatsappService.js';
import * as farmPool from '../services/farmPoolService.js';
import * as demandPool from '../services/demandPoolService.js';
import * as ai from '../services/aiService.js';
import * as policies from '../services/policyService.js';
import * as marketRoute from '../services/marketRouteService.js';

const id = (req) => idParam(req.params.id);

export const authController = {
  register: async (req, res) => created(res, await auth.register(req.body)),
  login: async (req, res) => ok(res, await auth.login(req.body, req.ip)),
  me: async (req, res) => ok(res, { user: req.user }),
};

export const farmController = {
  list: async (req, res) => ok(res, await farms.listFarmsForUser(req.user)),
  create: async (req, res) => created(res, await farms.createFarm(req.user, req.body)),
  get: async (req, res) => ok(res, await farms.getFarm(req.farmId)),
  update: async (req, res) => ok(res, await farms.updateFarm(req.user, req.farmId, req.body)),
  dashboard: async (req, res) => ok(res, await dashboard.getDashboard(req.farmId)),
  team: async (req, res) => ok(res, await farms.listFarmTeam(req.farmId)),
  createUser: async (req, res) => created(res, await farms.createFarmUser(req.user, req.farmId, req.body)),
  buyers: async (req, res) => ok(res, await buyers.listBuyersForFarm(req.farmId)),
  createBuyer: async (req, res) => created(res, await buyers.createManagedBuyer(req.user, req.farmId, req.body)),
  auditLogs: async (req, res) => ok(res, await audit.listAuditLogs(req.farmId)),
  whatsappLog: async (req, res) => ok(res, await notifications.listWhatsAppLog(req.farmId)),
};

export const produceController = {
  list: async (req, res) => ok(res, await produce.listProduce(req.farmId, { activeOnly: req.query.active === 'true' })),
  create: async (req, res) => created(res, await produce.createProduce(req.user, req.farmId, req.body)),
  get: async (req, res) => ok(res, await produce.getProduce(req.user, id(req))),
  update: async (req, res) => ok(res, await produce.updateProduce(req.user, id(req), req.body)),
};

export const harvestController = {
  list: async (req, res) => ok(res, await harvests.listHarvests(req.farmId, { includeClosed: req.query.includeClosed === 'true' })),
  create: async (req, res) => created(res, await harvests.createHarvest(req.user, req.farmId, req.body, req.ip)),
  get: async (req, res) => ok(res, await harvests.getHarvest(req.user, id(req))),
  update: async (req, res) => ok(res, await harvests.updateHarvest(req.user, id(req), req.body, req.ip)),
  markAvailable: async (req, res) => ok(res, await harvests.markAvailable(req.user, id(req), req.ip)),
  close: async (req, res) => ok(res, await harvests.closeHarvest(req.user, id(req), req.ip)),
  runMatching: async (req, res) => ok(res, await harvestMatch.runMatching(req.user, id(req), { route: req.body?.route || null, ip: req.ip })),
  matches: async (req, res) => ok(res, await harvestMatch.getMatchesForBatch(req.user, id(req))),
};

export const buyerController = {
  me: async (req, res) => ok(res, await buyers.getMyProfile(req.user)),
  updateMe: async (req, res) => ok(res, await buyers.updateMyProfile(req.user, req.body)),
};

export const demandController = {
  list: async (req, res) =>
    ok(res, req.farmId ? await demand.listForFarm(req.farmId, { status: req.query.status }) : await demand.listForBuyer(req.user)),
  create: async (req, res) => created(res, await demand.createDemand(req.user, req.body, req.ip)),
  get: async (req, res) => ok(res, await demand.getDemand(req.user, id(req))),
  update: async (req, res) => ok(res, await demand.updateDemand(req.user, id(req), req.body)),
  cancel: async (req, res) => ok(res, await demand.cancelDemand(req.user, id(req), req.ip)),
};

export const matchController = {
  preview: async (req, res) => ok(res, await matches.previewApproval(req.user, id(req), req.body)),
  list: async (req, res) =>
    ok(res, req.farmId ? await matches.listMatchesForFarm(req.farmId, { status: req.query.status }) : await matches.listMatchesForBuyer(req.user)),
  approve: async (req, res) => ok(res, await matches.approveMatch(req.user, id(req), req.body, req.ip)),
  reject: async (req, res) => ok(res, await matches.rejectMatch(req.user, id(req), req.body, req.ip)),
};

export const orderController = {
  list: async (req, res) =>
    ok(res, req.farmId ? await orders.listOrdersForFarm(req.farmId, { status: req.query.status }) : await orders.listOrdersForBuyer(req.user)),
  get: async (req, res) => ok(res, await orders.getOrder(req.user, id(req))),
  updateStatus: async (req, res) => ok(res, await orders.updateOrderStatus(req.user, id(req), req.body, req.ip)),
};

export const recoveryController = {
  candidates: async (req, res) => ok(res, await recovery.listRecoveryCandidates(req.farmId)),
  start: async (req, res) => ok(res, await recovery.startRecovery(req.user, id(req), req.body, req.ip)),
  get: async (req, res) => ok(res, await recovery.getRecovery(req.user, id(req))),
};

export const rescueController = {
  listPublic: async (_req, res) => ok(res, await rescue.listPublic()),
  list: async (req, res) => ok(res, await rescue.listForFarm(req.farmId)),
  create: async (req, res) => created(res, await rescue.createListing(req.user, req.body, req.ip)),
  update: async (req, res) => ok(res, await rescue.updateListing(req.user, id(req), req.body, req.ip)),
  cancel: async (req, res) => ok(res, await rescue.cancelListing(req.user, id(req), req.ip)),
  reserve: async (req, res) => created(res, await rescue.reserve(req.user, id(req), req.body, req.ip)),
};

export const campaignController = {
  list: async (req, res) => ok(res, await campaigns.listCampaigns(req.farmId)),
  generate: async (req, res) => created(res, await campaigns.generateCampaign(req.user, req.farmId, req.body, req.ip)),
  get: async (req, res) => ok(res, await campaigns.getCampaign(req.user, id(req))),
  update: async (req, res) => ok(res, await campaigns.updateCampaign(req.user, id(req), req.body)),
  approve: async (req, res) => ok(res, await campaigns.approveCampaign(req.user, id(req), req.ip)),
  send: async (req, res) => ok(res, await campaigns.sendCampaign(req.user, id(req), req.ip)),
  cancel: async (req, res) => ok(res, await campaigns.cancelCampaign(req.user, id(req), req.ip)),
};

export const analyticsController = {
  farm: async (req, res) => ok(res, await analytics.getFarmAnalytics(req.farmId)),
};

export const communityDropController = {
  upcoming: async (_req, res) => ok(res, await drops.listUpcoming()),
  list: async (req, res) => ok(res, await drops.listForFarm(req.farmId)),
  create: async (req, res) => created(res, await drops.createDrop(req.user, req.farmId, req.body, req.ip)),
  updateStatus: async (req, res) => ok(res, await drops.updateDropStatus(req.user, id(req), req.body?.status, req.ip)),
  join: async (req, res) => ok(res, await drops.joinDrop(req.user, id(req), idParam(req.body?.orderId, 'orderId'))),
};

export const marketplaceController = {
  supply: async (_req, res) => ok(res, await marketplace.getSupply()),
  farms: async (_req, res) => ok(res, await marketplace.listPublicFarms()),
};

export const notificationController = {
  list: async (req, res) => ok(res, await notifications.listForUser(req.user)),
  markRead: async (req, res) => {
    await notifications.markRead(req.user, id(req));
    ok(res, { id: id(req) });
  },
};

export const userController = {
  list: async (_req, res) => ok(res, await users.listUsers()),
  setActive: async (req, res) => ok(res, await users.setActive(req.user, id(req), req.body?.isActive)),
};

export const whatsappController = {
  verify: (req, res) => {
    const challenge = verifyWebhook({
      mode: req.query['hub.mode'],
      token: req.query['hub.verify_token'],
      challenge: req.query['hub.challenge'],
    });
    if (challenge === null) return res.sendStatus(403);
    // Plain text + nosniff: the echoed token is never interpreted as HTML.
    res.status(200).type('text/plain').set('X-Content-Type-Options', 'nosniff').send(challenge);
  },
  // Delivery status callbacks: acknowledged; status persistence is a later enhancement.
  receive: (_req, res) => res.sendStatus(200),
};


// ---------------------------------------------------------------- proposal features

export const marketRouteController = {
  assess: async (req, res) => ok(res, await marketRoute.getRouteAssessment(req.user, id(req))),
  select: async (req, res) => ok(res, await marketRoute.selectRoute(req.user, id(req), req.body, req.ip)),
};

export const extraHarvestController = {
  dispositions: async (req, res) => ok(res, await harvests.listDispositions(req.user, id(req))),
  recordDisposition: async (req, res) => created(res, await harvests.recordDisposition(req.user, id(req), req.body, req.ip)),
};

export const extraOrderController = {
  createDirect: async (req, res) => created(res, await orders.createDirectOrder(req.user, req.body, req.ip)),
  raiseDispute: async (req, res) => created(res, await orders.raiseDispute(req.user, id(req), req.body, req.ip)),
  listDisputes: async (req, res) => ok(res, await orders.listDisputes(req.user, { status: req.query.status })),
  resolveDispute: async (req, res) => ok(res, await orders.resolveDispute(req.user, id(req), req.body, req.ip)),
};

export const poolController = {
  farmPool: async (req, res) => ok(res, await farmPool.listFarmPool(req.user, req.farmId)),
  contribute: async (req, res) => created(res, await farmPool.contribute(req.user, idParam(req.params.demandId, 'demandId'), req.body, req.ip)),
  demandPoolSuggestions: async (req, res) => ok(res, await demandPool.listSuggestions(req.user, req.farmId)),
  demandPools: async (req, res) => ok(res, await demandPool.listPools(req.user, req.farmId)),
  createDemandPool: async (req, res) => created(res, await demandPool.createPool(req.user, req.body, req.ip)),
};

export const extraAnalyticsController = {
  comparison: async (req, res) => ok(res, await analytics.getComparison(req.farmId)),
  saveBaseline: async (req, res) => {
    await analytics.saveBaseline(req.user, req.farmId, req.body, req.ip);
    ok(res, await analytics.getComparison(req.farmId));
  },
};

export const aiController = {
  status: (_req, res) => ok(res, ai.aiStatus()),
  explainMatch: async (req, res) => ok(res, await ai.explainMatch(req.user, id(req))),
  insights: async (req, res) => ok(res, await ai.demandInsights(req.user, req.farmId)),
  variations: async (req, res) => ok(res, await ai.campaignVariations(req.user, id(req))),
  rescuePrice: async (req, res) => ok(res, await rescue.getPriceSuggestion(req.user, idParam(req.query.harvestBatchId, 'harvestBatchId'))),
};

export const adminController = {
  policies: async (_req, res) => ok(res, await policies.listPolicies()),
  updatePolicies: async (req, res) => ok(res, await policies.updatePolicies(req.user, req.body, req.ip)),
  auditLogs: async (_req, res) => ok(res, await audit.listPlatformAuditLogs()),
};

export const farmProfileController = {
  get: async (req, res) => ok(res, await marketplace.getFarmProfile(id(req))),
};
