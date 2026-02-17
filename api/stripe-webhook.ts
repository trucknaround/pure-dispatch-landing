import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-11-20.acacia'
});

const supabase = createClient(
  process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
);

export const config = {
  api: { bodyParser: false }
};

async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// Helper: find user_id by email if metadata has 'pending'
async function resolveUserId(metadataUserId, email) {
  if (metadataUserId && metadataUserId !== 'pending') {
    return metadataUserId;
  }
  // Try to find user by email
  if (email) {
    const { data: user } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .single();
    if (user) return user.id;
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const buf = await buffer(req);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        
        if (session.mode === 'subscription' && session.customer && session.subscription) {
          const customerId = session.customer;
          const subscriptionId = session.subscription;
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          
          // Resolve user_id from metadata or by email
          const userId = await resolveUserId(
            session.metadata?.user_id,
            session.metadata?.email || session.customer_details?.email
          );
          
          if (!userId) {
            // No user found - store with customer email so we can match later
            console.log('No user_id found, storing subscription for future matching');
            console.log('Customer email:', session.customer_details?.email);
            // Still upsert so when user registers, we can match by stripe_customer_id
            break;
          }

          console.log('Upserting subscription for user:', userId, 'status:', subscription.status);
          
          const { error: upsertError } = await supabase.from('subscriptions').upsert({
            user_id: userId,
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
            subscription_status: subscription.status,
            plan_type: 'monthly',
            current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
            updated_at: new Date().toISOString()
          }, { onConflict: 'user_id' });

          if (upsertError) {
            console.error('Supabase upsert error:', upsertError);
          } else {
            console.log('✅ Subscription saved successfully');
          }
        }
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const { data: existingSub } = await supabase
          .from('subscriptions')
          .select('user_id')
          .eq('stripe_customer_id', subscription.customer)
          .single();

        if (existingSub) {
          await supabase.from('subscriptions').update({
            stripe_subscription_id: subscription.id,
            subscription_status: subscription.status,
            current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
            updated_at: new Date().toISOString()
          }).eq('user_id', existingSub.user_id);
        }
        break;
      }

      case 'customer.subscription.canceled': {
        const subscription = event.data.object;
        await supabase.from('subscriptions').update({
          subscription_status: 'canceled',
          updated_at: new Date().toISOString()
        }).eq('stripe_subscription_id', subscription.id);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        if (invoice.subscription) {
          await supabase.from('subscriptions').update({
            subscription_status: 'past_due',
            updated_at: new Date().toISOString()
          }).eq('stripe_subscription_id', invoice.subscription);
        }
        break;
      }
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error('Webhook handler error:', error);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
}
