import { Request, Response } from 'express';
import { authService } from './auth.service';
import { setAuthCookies } from '../../utils/cookies';
import { SignupAdminInput, LoginAdminInput, LoginMemberInput, CreateMemberInput } from './auth.validation';

const getMessage = (error: unknown): string => {
	if (error instanceof Error) {
		return error.message;
	}
	return 'Something went wrong';
};

export const authController = {
	signupAdmin: async (req: Request, res: Response): Promise<void> => {
		try {
			const { name, organizationName, organizationSlug, email, password } = req.body as SignupAdminInput;

			const data = await authService.signupAdmin({
				name,
				organizationName,
				organizationSlug,
				email,
				password,
			});

			// Set HTTP-only cookies
			setAuthCookies(res, data.accessToken, data.refreshToken);

			res.status(201).json({
				admin: data.admin,
				accessToken: data.accessToken,
				refreshToken: data.refreshToken,
			});
		} catch (error) {
			res.status(400).json({ message: getMessage(error) });
		}
	},

	loginAdmin: async (req: Request, res: Response): Promise<void> => {
		try {
			const { email, password } = req.body as LoginAdminInput;

			const data = await authService.loginAdmin({ email, password });

			// Set HTTP-only cookies
			setAuthCookies(res, data.accessToken, data.refreshToken);

			res.status(200).json({
				admin: data.admin,
				accessToken: data.accessToken,
				refreshToken: data.refreshToken,
			});
		} catch (error) {
			res.status(401).json({ message: getMessage(error) });
		}
	},

	loginMember: async (req: Request, res: Response): Promise<void> => {
		try {
			const { role, memberId, password, organizationSlug } = req.body as LoginMemberInput;

			const data = await authService.loginMember({ role, memberId, password, organizationSlug });

			// Set HTTP-only cookies
			setAuthCookies(res, data.accessToken, data.refreshToken);

			res.status(200).json({
				member: data.member,
				accessToken: data.accessToken,
				refreshToken: data.refreshToken,
			});
		} catch (error) {
			res.status(401).json({ message: getMessage(error) });
		}
	},

	createUserByAdmin: async (req: Request, res: Response): Promise<void> => {
		try {
			const { name, memberId, routeId, email, phone, password } = req.body as CreateMemberInput;

			if (!req.user?.organizationId) {
				res.status(401).json({ message: 'Unauthorized' });
				return;
			}

			const user = await authService.createUserByAdmin(req.user.organizationId, {
				name,
				memberId,
				routeId,
				email,
				phone,
				password,
			});

			res.status(201).json({ user });
		} catch (error) {
			res.status(400).json({ message: getMessage(error) });
		}
	},

	createDriverByAdmin: async (req: Request, res: Response): Promise<void> => {
		try {
			const { name, memberId, email, phone, password } = req.body as CreateMemberInput;

			if (!req.user?.organizationId) {
				res.status(401).json({ message: 'Unauthorized' });
				return;
			}

			const driver = await authService.createDriverByAdmin(req.user.organizationId, {
				name,
				memberId,
				email,
				phone,
				password,
			});

			res.status(201).json({ driver });
		} catch (error) {
			res.status(400).json({ message: getMessage(error) });
		}
	},
};

