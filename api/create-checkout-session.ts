import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-11-20.acacia'
});

const supabase = createClient(
  process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    let userId = null;
    let userEmail = null;

    // ==========================================
    // AUTH: Support both app JWT and landing page (no auth)
    // ==========================================
    const authHeader = req.headers.authorization;
    
    if (authHeader?.startsWith('Bearer ')) {
      // App user - decode custom JWT
      const token = authHeader.substring(7);
      try {
        const base64Payload = token.split('.')[1];
        const payload = JSON.parse(Buffer.from(base64Payload, 'base64').toString('utf-8'));
        userId = payload.userId;
        userEmail = payload.email;
        if (payload.exp && Date.now() / 1000 > payload.exp) {
          return res.status(401).json({ error: 'Token expired' });
        }
      } catch (e) {
        return res.status(401).json({ error: 'Invalid token' });
      }
    } else {
      // Landing page user - get email from request body
      const { email } = req.body || {};
      if (!email) {
        return res.status(400).json({ error: 'Email required' });
      }
      userEmail = email;
      
      // Try to find existing user in the users table by email
      const { data: existingUser } = await supabase
        .from('users')
        .select('id')
        .eq('email', email)
        .single();
      
      if (existingUser) {
        userId = existingUser.id;
      }
    }

    if (!userEmail) {
      return res.status(400).json({ error: 'No email provided' });
    }

    console.log('Creating checkout for:', { userId, userEmail });

    // ==========================================
    // CHECK FOR EXISTING STRIPE CUSTOMER
    // ==========================================
    let customerId = null;

    if (userId) {
      const { data: existingSub } = await supabase
        .from('subscriptions')
        .select('stripe_customer_id')
        .eq('user_id', userId)
        .single();
      customerId = existingSub?.stripe_customer_id;
    }

    // Also check by email in Stripe
    if (!customerId) {
      const customers = await stripe.customers.list({ email: userEmail, limit: 1 });
      if (customers.data.length > 0) {
        customerId = customers.data[0].id;
      }
    }

    // Create Stripe customer if needed
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: userEmail,
        metadata: { user_id: userId || 'pending' }
      });
      customerId = customer.id;
      console.log('Created new Stripe customer:', customerId);
    }

    // Save customer ID to subscriptions table if we have a userId
    if (userId) {
      await supabase
        .from('subscriptions')
        .upsert({
          user_id: userId,
          stripe_customer_id: customerId,
          subscription_status: 'inactive'
        }, { onConflict: 'user_id' });
    }

    // ==========================================
    // CREATE STRIPE CHECKOUT SESSION
    // ==========================================
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${process.env.VITE_APP_URL || 'https://pure-dispatch.vercel.app'}?session_id={CHECKOUT_SESSION_ID}&subscribed=true`,
      cancel_url: `${process.env.VITE_APP_URL || 'https://pure-dispatch.vercel.app'}?canceled=true`,
      metadata: {
        user_id: userId || 'pending',
        email: userEmail
      }
    });

    console.log('Checkout session created:', session.id);
    return res.status(200).json({ url: session.url });

  } catch (error) {
    console.error('Checkout session creation error:', error);
    return res.status(500).json({ error: 'Failed to create checkout session' });
  }
}
