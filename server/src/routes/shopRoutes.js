import { Router } from 'express';
import { verifyToken, requireRole, requireFarmAccess, FARM_ADMIN_ROLES } from '../middleware/auth.js';
import { ok, created } from '../utils/response.js';
import { idParam } from '../utils/validate.js';
import * as shop from '../services/shopService.js';

const router = Router();
router.get('/farms/:farmId', async (req,res) => ok(res, await shop.listShop(idParam(req.params.farmId))));
router.use(verifyToken);
router.get('/manage', requireRole(...FARM_ADMIN_ROLES), requireFarmAccess, async (req,res) => ok(res, await shop.listShop(req.farmId, true)));
router.get('/insights', requireRole(...FARM_ADMIN_ROLES), requireFarmAccess, async (req,res) => ok(res, await shop.shopInsights(req.farmId)));
router.post('/listings', requireRole(...FARM_ADMIN_ROLES), requireFarmAccess, async (req,res) => created(res, await shop.publishListing(req.user,req.farmId,req.body,req.ip)));
router.post('/listings/:id/close', requireRole(...FARM_ADMIN_ROLES), async (req,res) => ok(res, await shop.closeListing(req.user,idParam(req.params.id))));
router.post('/listings/:id/checkout', requireRole('consumer'), async (req,res) => created(res, await shop.checkout(req.user,idParam(req.params.id),req.body,req.ip)));
router.get('/rewards/:farmId', requireRole('consumer'), async (req,res) => ok(res, await shop.rewards(req.user,idParam(req.params.farmId))));
export default router;
