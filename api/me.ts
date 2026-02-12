import { createClient } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

interface UserSession {
  authenticated: boolean;
  subscription_status: string | null;
  plan_type: string | null;
  user_id: string | null;
}

const supabase = createClient(
  process.env.VITE_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Credentials', 'true');
 const allowedOrigins = [
  'https://pure-dispatch-landing.vercel.app',
  'https://pure-dispatch.vercel.app',
  'http://localhost:3000',
  'http://localhost:5173'
];

const origin = req.headers.origin as string;
if (allowedOrigins.includes(origin)) {
  res.setHeader('Access-Control-Allow-Origin', origin);
} else {
  res.setHeader('Access-Control-Allow-Origin', 'https://pure-dispatch.vercel.app');
}
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Extract JWT from Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(200).json({
        authenticated: false,
        subscription_status: null,
        plan_type: null,
        user_id: null
      } as UserSession);
    }

    const token = authHeader.substring(7);

    // Verify JWT and get user
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !user) {
      return res.status(200).json({
        authenticated: false,
        subscription_status: null,
        plan_type: null,
        user_id: null
      } as UserSession);
    }

    // Fetch subscription status
    const { data: subscription, error: subError } = await supabase
      .from('subscriptions')
      .select('subscription_status, plan_type')
      .eq('user_id', user.id)
      .single();

    if (subError || !subscription) {
      // Authenticated but no subscription
      return res.status(200).json({
        authenticated: true,
        subscription_status: null,
        plan_type: null,
        user_id: user.id
      } as UserSession);
    }

    // Authenticated with subscription
    return res.status(200).json({
      authenticated: true,
      subscription_status: subscription.subscription_status,
      plan_type: subscription.plan_type,
      user_id: user.id
    } as UserSession);

  } catch (error) {
    console.error('Error in /api/me:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
