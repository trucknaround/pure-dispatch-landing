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

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // ==========================================
    // VERIFY TOKEN - Supports custom JWT from app
    // ==========================================
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.substring(7);
    let userId = null;
    let userEmail = null;

    // Decode the custom JWT (from your Node.js backend)
    try {
      const base64Payload = token.split('.')[1];
      const payload = JSON.parse(
        Buffer.from(base64Payload, 'base64').toString('utf-8')
      );
      userId = payload.userId;
      userEmail = payload.email;

      // Check token expiry
      if (payload.exp && Date.now() / 1000 > payload.exp) {
        return res.status(401).json({ error: 'Token expired' });
      }
    } catch (decodeError) {
      console.error('Token decode error:', decodeError);
      return res.status(401).json({ error: 'Invalid token' });
    }

    if (!userId) {
      return res.status(401).json({ error: 'Invalid token - no userId' });
    }

    console.log('Creating checkout for user:', userId, userEmail);

    // ==========================================
    // CHECK FOR EXISTING STRIPE CUSTOMER
    // ==========================================
    let customerId = null;

    // Check subscriptions table for existing stripe_customer_id
    const { data: existingSub } = await supabase
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', userId)
      .single();

    customerId = existingSub?.stripe_customer_id;

    // Create Stripe customer if needed
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: userEmail,
        metadata: {
          user_id: userId
        }
      });
      customerId = customer.id;
      console.log('Created new Stripe customer:', customerId);

      // Save customer ID to subscriptions table
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
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID,
          quantity: 1,
        },
      ],
      success_url: `${process.env.VITE_APP_URL || 'https://pure-dispatch.vercel.app'}?session_id={CHECKOUT_SESSION_ID}&subscribed=true`,
      cancel_url: `${process.env.VITE_APP_URL || 'https://pure-dispatch.vercel.app'}?canceled=true`,
      metadata: {
        user_id: userId
      }
    });

    console.log('Checkout session created:', session.id);
    return res.status(200).json({ url: session.url });

  } catch (error) {
    console.error('Checkout session creation error:', error);
    return res.status(500).json({ error: 'Failed to create checkout session' });
  }
}
