import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { requireRole } from '../../middleware/role.middleware';
import { validate } from '../../middleware/validate.middleware';
import { ROLES } from '../../constants/roles';
import { authController } from './auth.controller';
import {
	refreshTokenController,
	logoutController,
	logoutUserController,
	logoutDriverController,
} from './auth.token.controller';
import { authDebugController } from './auth.debug.controller';
import { signupAdminSchema, loginAdminSchema, loginMemberSchema, createMemberSchema } from './auth.validation';

export const authRouter = Router();

authRouter.post('/admin/signup', validate(signupAdminSchema), authController.signupAdmin);
authRouter.post('/admin/login', validate(loginAdminSchema), authController.loginAdmin);
authRouter.post('/member/login', validate(loginMemberSchema), authController.loginMember);

// Token management
authRouter.post('/refresh', refreshTokenController);
authRouter.post('/logout', logoutController);
authRouter.post('/logout/user', requireAuth, requireRole(ROLES.USER), logoutUserController);
authRouter.post('/logout/driver', requireAuth, requireRole(ROLES.DRIVER), logoutDriverController);

// Debug route - check your token
authRouter.get('/whoami', requireAuth, authDebugController.whoami);

authRouter.post('/admin/users', requireAuth, requireRole(ROLES.ADMIN), validate(createMemberSchema), authController.createUserByAdmin);
authRouter.post('/admin/drivers', requireAuth, requireRole(ROLES.ADMIN), validate(createMemberSchema), authController.createDriverByAdmin);



