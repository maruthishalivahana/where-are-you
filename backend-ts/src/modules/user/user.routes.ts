import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { requireRole } from '../../middleware/role.middleware';
import { requireActivePlan } from '../../middleware/plan.middleware';
import { validate } from '../../middleware/validate.middleware';
import { ROLES } from '../../constants/roles';
import { userController } from './user.controller';
import { z } from 'zod';

export const userRouter = Router();

const updateUserSchema = z.object({
    body: z.object({
        name: z.string().min(2, 'name must be at least 2 characters').optional(),
        memberId: z.string().min(1, 'memberId cannot be empty').optional(),
        routeId: z.string().min(1, 'routeId cannot be empty').optional(),
        email: z.string().email('invalid email address').optional(),
        phone: z.string().min(7, 'phone must be at least 7 characters').max(20, 'phone must be at most 20 characters').optional(),
        password: z.string().min(6, 'password must be at least 6 characters').optional(),
    }),
});

userRouter.use(requireAuth, requireRole(ROLES.ADMIN), requireActivePlan);

userRouter.get('/', userController.getUsers);
userRouter.get('/:id', userController.getUserById);
userRouter.put('/:id', validate(updateUserSchema), userController.updateUser);
userRouter.delete('/:id', userController.deleteUser);
