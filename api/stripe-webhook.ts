import { createClient } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-11-20.acacia'
});

const supabase = createClient(
  process.env.VITE_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Disable body parsing, need raw body for signature verification
export const config = {
  api: {
    bodyParser: false,
  },
};

async function buffer(readable: VercelRequest) {
  const chunks: Buffer[] = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const buf = await buffer(req);
  const sig = req.headers['stripe-signature']!;

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      buf,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        
        if (session.mode === 'subscription' && session.customer && session.subscription) {
          const customerId = session.customer as string;
          const subscriptionId = session.subscription as string;
          
          // Get full subscription details
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          
          // Get user_id from metadata
          const userId = session.metadata?.user_id;
          
          if (!userId) {
            console.error('No user_id in session metadata');
            break;
          }

          // Upsert subscription
          await supabase.from('subscriptions').upsert({
            user_id: userId,
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
            subscription_status: subscription.status,
            plan_type: 'monthly',
            current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
            updated_at: new Date().toISOString()
          }, {
            onConflict: 'user_id'
          });
        }
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        
        // Find user by customer ID
        const { data: existingSub } = await supabase
          .from('subscriptions')
          .select('user_id')
          .eq('stripe_customer_id', subscription.customer as string)
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
        const subscription = event.data.object as Stripe.Subscription;
        
        await supabase.from('subscriptions').update({
          subscription_status: 'canceled',
          updated_at: new Date().toISOString()
        }).eq('stripe_subscription_id', subscription.id);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        
        if (invoice.subscription) {
          await supabase.from('subscriptions').update({
            subscription_status: 'past_due',
            updated_at: new Date().toISOString()
          }).eq('stripe_subscription_id', invoice.subscription as string);
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
