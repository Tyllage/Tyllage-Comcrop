import { Router } from 'express';
import { verifyToken, requireRole, requireFarmAccess, FARM_ROLES, FARM_ADMIN_ROLES } from '../middleware/auth.js';
import { farmController as c } from '../controllers/index.js';
import { buyerGrowth, saveRelationship } from '../services/buyerGrowthService.js';
import { ok } from '../utils/response.js';
import { idParam } from '../utils/validate.js';

const router = Router();
router.use(verifyToken);

router.get('/', requireRole(...FARM_ROLES), c.list);
router.post('/', requireRole('platform_admin'), c.create);

router.get('/:farmId', requireRole(...FARM_ROLES), requireFarmAccess, c.get);
router.patch('/:farmId', requireRole(...FARM_ADMIN_ROLES), requireFarmAccess, c.update);
router.get('/:farmId/dashboard', requireRole(...FARM_ROLES), requireFarmAccess, c.dashboard);
router.get('/:farmId/team', requireRole(...FARM_ROLES), requireFarmAccess, c.team);
router.post('/:farmId/users', requireRole('platform_admin'), requireFarmAccess, c.createUser);
router.get('/:farmId/buyers', requireRole(...FARM_ROLES), requireFarmAccess, c.buyers);
router.get('/:farmId/buyer-growth', requireRole(...FARM_ADMIN_ROLES), requireFarmAccess, async (req,res)=>ok(res,await buyerGrowth(req.farmId)));
router.patch('/:farmId/buyer-growth/:buyerId', requireRole(...FARM_ADMIN_ROLES), requireFarmAccess, async (req,res)=>ok(res,await saveRelationship(req.user,req.farmId,idParam(req.params.buyerId),req.body,req.ip)));
router.post('/:farmId/buyers', requireRole(...FARM_ADMIN_ROLES), requireFarmAccess, c.createBuyer);
router.get('/:farmId/audit-logs', requireRole(...FARM_ADMIN_ROLES), requireFarmAccess, c.auditLogs);
router.get('/:farmId/whatsapp-log', requireRole(...FARM_ADMIN_ROLES), requireFarmAccess, c.whatsappLog);

export default router;
