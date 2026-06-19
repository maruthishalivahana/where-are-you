import { Admin } from '../admin/admin.model';
import { Driver } from '../driver/driver.model';
import { Organization } from '../organization/organization.model';
import { User } from '../user/user.model';
import { Route } from '../route/route.model';
import { ROLES } from '../../constants/roles';
import { comparePassword } from '../../utils/comparePassword';
import { generateTokens } from '../../utils/generateTokens';
import { hashPassword } from '../../utils/hashPassword';
import { planService } from '../plan/plan.service';
import { emailService } from '../../services/email';

interface AdminSignupInput {
	name: string;
	organizationName: string;
	organizationSlug: string;
	email: string;
	password: string;
}

interface AdminLoginInput {
	email: string;
	password: string;
}

interface MemberLoginInput {
	role: 'user' | 'driver';
	memberId: string;
	password: string;
	organizationSlug: string;
}

interface CreateMemberInput {
	name: string;
	memberId: string;
	routeId?: string;
	email?: string;
	phone?: string;
	password: string;
}

const normalizeEmail = (email: string): string => email.trim().toLowerCase();
const normalizePhone = (phone: string): string => phone.trim();

const normalizeOrganizationSlug = (organizationSlug: string): string => {
	return organizationSlug
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '') || 'organization';
};

export const authService = {
	signupAdmin: async (input: AdminSignupInput) => {
		const existingAdmin = await Admin.findOne({ email: normalizeEmail(input.email) });

		if (existingAdmin) {
			throw new Error('Admin email already exists');
		}

		const slug = normalizeOrganizationSlug(input.organizationSlug);

		if (await Organization.exists({ slug })) {
			throw new Error('Organization ID already exists. Please choose another one');
		}

		const organization = await Organization.create({
			name: input.organizationName.trim(),
			slug,
		});

		const passwordHash = await hashPassword(input.password);

		const admin = await Admin.create({
			organizationId: organization._id,
			name: input.name.trim(),
			email: normalizeEmail(input.email),
			passwordHash,
		});

		const { accessToken, refreshToken } = generateTokens({
			sub: String(admin._id),
			organizationId: String(admin.organizationId),
			role: ROLES.ADMIN,
		});

		// Fire-and-forget welcome email (never blocks the signup response)
		emailService.sendWelcomeEmail({
			adminEmail: admin.email,
			adminName: admin.name,
			organizationName: organization.name,
			organizationId: String(organization._id),
			adminId: String(admin._id),
		}).catch(() => { /* logged inside emailService */ });

		return {
			accessToken,
			refreshToken,
			admin: {
				id: String(admin._id),
				name: admin.name,
				email: admin.email,
				organization: {
					id: String(organization._id),
					name: organization.name,
					slug: organization.slug,
					plan: await planService.getCurrentPlan(String(organization._id)),
				},
			},
		};
	},

	loginAdmin: async (input: AdminLoginInput) => {
		const admin = await Admin.findOne({ email: normalizeEmail(input.email) });

		if (!admin) {
			throw new Error('Invalid credentials');
		}

		const passwordValid = await comparePassword(input.password, admin.passwordHash);

		if (!passwordValid) {
			throw new Error('Invalid credentials');
		}

		const organization = await Organization.findById(admin.organizationId);

		if (!organization) {
			throw new Error('Organization not found for admin');
		}

		const { accessToken, refreshToken } = generateTokens({
			sub: String(admin._id),
			organizationId: String(admin.organizationId),
			role: ROLES.ADMIN,
		});

		return {
			accessToken,
			refreshToken,
			admin: {
				id: String(admin._id),
				name: admin.name,
				email: admin.email,
				organization: {
					id: String(organization._id),
					name: organization.name,
					slug: organization.slug,
					plan: await planService.getCurrentPlan(String(organization._id)),
				},
			},
		};
	},

	loginMember: async (input: MemberLoginInput) => {
		const organizationSlug = normalizeOrganizationSlug(input.organizationSlug);
		const organization = await Organization.findOne({ slug: organizationSlug });

		if (!organization) {
			throw new Error('Organization not found');
		}

		if (input.role === ROLES.USER) {
			const user = await User.findOne({
				organizationId: organization._id,
				memberId: input.memberId,
			});

			if (!user || !(await comparePassword(input.password, user.passwordHash))) {
				throw new Error('Invalid credentials');
			}

			const { accessToken, refreshToken } = generateTokens({
				sub: String(user._id),
				organizationId: String(user.organizationId),
				role: ROLES.USER,
			});

			return {
				accessToken,
				refreshToken,
				member: {
					id: String(user._id),
					role: ROLES.USER,
					name: user.name,
					memberId: user.memberId,
				},
			};
		}

		const driver = await Driver.findOne({
			organizationId: organization._id,
			memberId: input.memberId,
		});

		if (!driver || !(await comparePassword(input.password, driver.passwordHash))) {
			throw new Error('Invalid credentials');
		}

		const { accessToken, refreshToken } = generateTokens({
			sub: String(driver._id),
			organizationId: String(driver.organizationId),
			role: ROLES.DRIVER,
		});

		return {
			accessToken,
			refreshToken,
			member: {
				id: String(driver._id),
				role: ROLES.DRIVER,
				name: driver.name,
				memberId: driver.memberId,
			},
		};
	},

	createUserByAdmin: async (organizationId: string, input: CreateMemberInput) => {
		const normalizedEmail = input.email ? normalizeEmail(input.email) : undefined;
		const normalizedPhone = input.phone ? normalizePhone(input.phone) : undefined;
		const routeId = input.routeId?.trim();

		if (routeId) {
			const route = await Route.findOne({ _id: routeId, organizationId });
			if (!route) {
				throw new Error('Route not found');
			}
		}

		const existingUser = await User.findOne({
			organizationId,
			memberId: input.memberId,
		});

		if (existingUser) {
			throw new Error('User memberId already exists');
		}

		if (normalizedEmail) {
			const duplicateEmail = await User.findOne({
				organizationId,
				email: normalizedEmail,
			});
			if (duplicateEmail) {
				throw new Error('User email already exists');
			}
		}

		if (normalizedPhone) {
			const duplicatePhone = await User.findOne({
				organizationId,
				phone: normalizedPhone,
			});
			if (duplicatePhone) {
				throw new Error('User phone already exists');
			}
		}

		const user = await User.create({
			organizationId,
			name: input.name.trim(),
			memberId: input.memberId.trim(),
			routeId: routeId ? routeId : undefined,
			email: normalizedEmail,
			phone: normalizedPhone,
			passwordHash: await hashPassword(input.password),
		});

		return {
			id: String(user._id),
			name: user.name,
			memberId: user.memberId,
			routeId: user.routeId ? String(user.routeId) : null,
			email: user.email || null,
			phone: user.phone || null,
		};
	},

	createDriverByAdmin: async (organizationId: string, input: CreateMemberInput) => {
		const normalizedEmail = input.email ? normalizeEmail(input.email) : undefined;
		const normalizedPhone = input.phone ? normalizePhone(input.phone) : undefined;

		const existingDriver = await Driver.findOne({
			organizationId,
			memberId: input.memberId,
		});

		if (existingDriver) {
			throw new Error('Driver memberId already exists');
		}

		if (normalizedEmail) {
			const duplicateEmail = await Driver.findOne({
				organizationId,
				email: normalizedEmail,
			});
			if (duplicateEmail) {
				throw new Error('Driver email already exists');
			}
		}

		if (normalizedPhone) {
			const duplicatePhone = await Driver.findOne({
				organizationId,
				phone: normalizedPhone,
			});
			if (duplicatePhone) {
				throw new Error('Driver phone already exists');
			}
		}

		const driver = await Driver.create({
			organizationId,
			name: input.name.trim(),
			memberId: input.memberId.trim(),
			email: normalizedEmail,
			phone: normalizedPhone,
			passwordHash: await hashPassword(input.password),
		});

		return {
			id: String(driver._id),
			name: driver.name,
			memberId: driver.memberId,
			email: driver.email || null,
			phone: driver.phone || null,
		};
	},
};

