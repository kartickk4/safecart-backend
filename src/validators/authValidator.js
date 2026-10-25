const { z } = require('zod');

// Schema for user signup
const signupSchema = z.object({
  email: z.string().trim().email('Please provide a valid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters long'),
  phone: z.string().trim().min(10, 'Phone number must be at least 10 digits'),
  fullName: z.string().trim().min(2, 'Full name must be at least 2 characters long'),
  role: z.enum(['Supplier', 'Receiver']).optional().default('Receiver'),
  referralCode: z.string().trim().optional()
});

// Schema for user login
const loginSchema = z.object({
  email: z.string().trim().email('Please provide a valid email address'),
  password: z.string().min(1, 'Password is required'),
  role: z.enum(['Supplier', 'Receiver', 'Admin', 'super_admin']).optional()
});

// Schema for sending OTP
const sendOtpSchema = z.object({
  phone: z.string().trim().min(10, 'Valid 10-digit mobile number required'),
  role: z.enum(['Supplier', 'Receiver']).optional()
});

// Schema for verifying OTP
const verifyOtpSchema = z.object({
  phone: z.string().trim().min(10, 'Valid 10-digit mobile number required'),
  otp: z.string().trim().length(6, 'OTP must be 6 digits'),
  role: z.enum(['Supplier', 'Receiver']).optional()
});

// Schema for sending Email OTP
const sendEmailOtpSchema = z.object({
  email: z.string().trim().email('Please provide a valid email address'),
  role: z.enum(['Supplier', 'Receiver']).optional()
});

// Schema for verifying Email OTP
const verifyEmailOtpSchema = z.object({
  email: z.string().trim().email('Please provide a valid email address'),
  code: z.string().trim().length(6, 'Verification code must be 6 digits'),
  role: z.enum(['Supplier', 'Receiver']).optional()
});

// Schema for forgot password
const forgotPasswordSchema = z.object({
  email: z.string().trim().email('Please provide a valid email address').optional(),
  phone: z.string().trim().min(10, 'Valid 10-digit phone number required').optional(),
  role: z.enum(['Supplier', 'Receiver']).optional().default('Receiver')
}).refine(data => data.email || data.phone, {
  message: 'Either email or phone is required to reset password'
});

module.exports = {
  signupSchema,
  loginSchema,
  sendOtpSchema,
  verifyOtpSchema,
  sendEmailOtpSchema,
  verifyEmailOtpSchema,
  forgotPasswordSchema,
  resetPasswordSchema
};
