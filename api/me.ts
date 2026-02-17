import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(200).json({
        authenticated: false,
        subscription_status: null,
        plan_type: null,
        user_id: null
      });
    }

    const token = authHeader.substring(7);
    let userId = null;
    let userEmail = null;

    // Decode custom JWT
    try {
      const base64Payload = token.split('.')[1];
      const payload = JSON.parse(Buffer.from(base64Payload, 'base64').toString('utf-8'));
      userId = payload.userId;
      userEmail = payload.email;

      if (payload.exp && Date.now() / 1000 > payload.exp) {
        return res.status(200).json({
          authenticated: false,
          subscription_status: null,
          plan_type: null,
          user_id: null
        });
      }
    } catch (decodeError) {
      return res.status(200).json({
        authenticated: false,
        subscription_status: null,
        plan_type: null,
        user_id: null
      });
    }

    if (!userId) {
      return res.status(200).json({
        authenticated: false,
        subscription_status: null,
        plan_type: null,
        user_id: null
      });
    }

    // Check subscription by user_id first
    let subscription = null;
    const { data: subByUserId } = await supabase
      .from('subscriptions')
      .select('subscription_status, plan_type')
      .eq('user_id', userId)
      .single();

    if (subByUserId) {
      subscription = subByUserId;
    }

    // If no subscription found by user_id, check by email via Stripe customer
    if (!subscription && userEmail) {
      // Look for a subscription where the Stripe customer has this email
      const { data: allSubs } = await supabase
        .from('subscriptions')
        .select('subscription_status, plan_type, stripe_customer_id, user_id');
      
      if (allSubs) {
        for (const sub of allSubs) {
          if (sub.subscription_status === 'active') {
            // Check if this Stripe customer matches our email
            // This handles the case where someone paid from landing page
            // We'll link it to their account
            try {
              const Stripe = (await import('stripe')).default;
              const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
              const customer = await stripe.customers.retrieve(sub.stripe_customer_id);
              if (customer.email === userEmail) {
                subscription = sub;
                // Link this subscription to the user's account
                await supabase
                  .from('subscriptions')
                  .update({ user_id: userId })
                  .eq('stripe_customer_id', sub.stripe_customer_id);
                console.log('Linked subscription to user:', userId);
                break;
              }
            } catch (e) {
              console.error('Stripe customer lookup error:', e);
            }
          }
        }
      }
    }

    return res.status(200).json({
      authenticated: true,
      subscription_status: subscription?.subscription_status || null,
      plan_type: subscription?.plan_type || null,
      user_id: userId
    });

  } catch (error) {
    console.error('Error in /api/me:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
