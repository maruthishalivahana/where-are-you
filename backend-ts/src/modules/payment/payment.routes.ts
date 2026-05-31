import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { requireRole } from '../../middleware/role.middleware';
import { ROLES } from '../../constants/roles';
import { paymentController } from './payment.controller';

export const paymentRouter = Router();

paymentRouter.use(requireAuth, requireRole(ROLES.ADMIN));

paymentRouter.post('/razorpay/order', paymentController.createRazorpayOrder);
paymentRouter.post('/razorpay/verify', paymentController.verifyRazorpayPayment);
paymentRouter.get('/razorpay/status', paymentController.getRazorpayStatus);
