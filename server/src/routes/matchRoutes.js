import { Router } from 'express';
import { verifyToken, farmScopeForFarmUsers, requireRole, FARM_ADMIN_ROLES } from '../middleware/auth.js';
import { matchController as c } from '../controllers/index.js';

const router = Router();
router.use(verifyToken);

router.get('/', farmScopeForFarmUsers, c.list);
router.post('/:id/preview', requireRole(...FARM_ADMIN_ROLES), c.preview);
router.post('/:id/approve', requireRole(...FARM_ADMIN_ROLES), c.approve);
router.post('/:id/reject', requireRole(...FARM_ADMIN_ROLES), c.reject);

export default router;
