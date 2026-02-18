// ============================================
// API: /api/follow-up-check.ts
// Deploy to: pure-dispatch-landing/api/follow-up-check.ts
// ============================================
// CRON JOB — runs daily at 9 AM UTC (via Vercel Cron)
// Checks for scheduled follow-up emails that are due and sends them.
//
// Add to vercel.json:
// {
//   "crons": [
//     { "path": "/api/follow-up-check", "schedule": "0 9 * * *" }
//   ]
// }
//
// Can also be called manually:
//   GET /api/follow-up-check → runs the check now
// ============================================

import { createClient } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import sgMail from '@sendgrid/mail';

const supabase = createClient(
  process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || ''
);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Verify this is from Vercel Cron or manual call
  // In production, you'd check req.headers['authorization'] === `Bearer ${process.env.CRON_SECRET}`
  
  console.log('[Follow-Up Check] Starting...');

  try {
    // Find all scheduled campaigns that are due
    const now = new Date().toISOString();

    const { data: pendingCampaigns, error: fetchError } = await supabase
      .from('outreach_campaigns')
      .select(`
        *,
        broker:brokers(id, company_name, contact_name, email, outreach_status),
        carrier_profile:carrier_profiles!outreach_campaigns_carrier_id_fkey(*)
      `)
      .eq('status', 'scheduled')
      .lte('scheduled_at', now)
      .order('scheduled_at')
      .limit(100);

    if (fetchError) throw fetchError;

    if (!pendingCampaigns || pendingCampaigns.length === 0) {
      console.log('[Follow-Up Check] No pending follow-ups due.');
      return res.status(200).json({ message: 'No pending follow-ups', processed: 0 });
    }

    console.log(`[Follow-Up Check] Found ${pendingCampaigns.length} follow-ups to send.`);

    const sendGridKey = process.env.SENDGRID_API_KEY;
    const fromEmail = process.env.SENDGRID_FROM_EMAIL;
    const results: Array<{ id: string; broker: string; status: string; error?: string }> = [];

    for (const campaign of pendingCampaigns) {
      const broker = campaign.broker as any;
      const carrier = campaign.carrier_profile as any;

      // Skip if broker no longer has email
      if (!broker?.email) {
        await supabase.from('outreach_campaigns').update({
          status: 'failed',
          error_message: 'Broker has no email address',
        }).eq('id', campaign.id);

        results.push({ id: campaign.id, broker: broker?.company_name || 'Unknown', status: 'skipped', error: 'No email' });
        continue;
      }

      // Skip if broker has already responded to any campaign in this sequence
      if (broker.outreach_status === 'responded' || broker.outreach_status === 'active') {
        await supabase.from('outreach_campaigns').update({
          status: 'cancelled',
          error_message: 'Broker already responded — follow-up cancelled',
        }).eq('id', campaign.id);

        results.push({ id: campaign.id, broker: broker.company_name, status: 'cancelled', error: 'Already responded' });
        continue;
      }

      // Skip if broker was blacklisted
      if (broker.outreach_status === 'blacklisted') {
        await supabase.from('outreach_campaigns').update({
          status: 'cancelled',
          error_message: 'Broker is blacklisted',
        }).eq('id', campaign.id);

        results.push({ id: campaign.id, broker: broker.company_name, status: 'cancelled', error: 'Blacklisted' });
        continue;
      }

      // Send the email
      let sendSuccess = false;
      let messageId = '';
      let sendError = '';

      if (sendGridKey && fromEmail) {
        sgMail.setApiKey(sendGridKey);
        try {
          const senderName = carrier?.owner_name || carrier?.company_name || 'Pure Dispatch';
          const [response] = await sgMail.send({
            to: broker.email,
            from: { email: fromEmail, name: senderName },
            subject: campaign.subject || 'Following Up',
            text: campaign.body_text || '',
          });
          sendSuccess = true;
          messageId = response?.headers?.['x-message-id'] || '';
        } catch (err: any) {
          sendError = err.message;
        }
      } else {
        // DEV MODE
        console.log(`[DEV MODE] Follow-up to ${broker.email}: ${campaign.subject}`);
        sendSuccess = true;
        messageId = 'dev-mode';
      }

      // Update campaign record
      await supabase.from('outreach_campaigns').update({
        status: sendSuccess ? 'sent' : 'failed',
        sent_at: sendSuccess ? new Date().toISOString() : null,
        sendgrid_message_id: messageId || null,
        error_message: sendError || null,
      }).eq('id', campaign.id);

      // Update broker contact tracking
      if (sendSuccess) {
        const { data: brokerData } = await supabase
          .from('brokers')
          .select('total_outreach_attempts')
          .eq('id', campaign.broker_id)
          .single();

        await supabase.from('brokers').update({
          last_contact_date: new Date().toISOString(),
          total_outreach_attempts: (brokerData?.total_outreach_attempts || 0) + 1,
        }).eq('id', campaign.broker_id);
      }

      results.push({
        id: campaign.id,
        broker: broker.company_name,
        status: sendSuccess ? 'sent' : 'failed',
        error: sendError || undefined,
      });
    }

    const sent = results.filter(r => r.status === 'sent').length;
    const failed = results.filter(r => r.status === 'failed').length;
    const skipped = results.filter(r => r.status === 'skipped' || r.status === 'cancelled').length;

    console.log(`[Follow-Up Check] Complete: ${sent} sent, ${failed} failed, ${skipped} skipped`);

    return res.status(200).json({
      message: `Follow-up check complete: ${sent} sent, ${failed} failed, ${skipped} skipped`,
      processed: pendingCampaigns.length,
      sent,
      failed,
      skipped,
      results,
    });
  } catch (err: any) {
    console.error('[Follow-Up Check Error]', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
