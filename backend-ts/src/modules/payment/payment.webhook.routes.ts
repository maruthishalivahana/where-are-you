import { Router } from 'express';
import { paymentController } from './payment.controller';

export const paymentWebhookRouter = Router();

paymentWebhookRouter.post('/razorpay', paymentController.razorpayWebhook);
