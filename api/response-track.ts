import { createClient } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import jwt from 'jsonwebtoken';

const supabase = createClient(
  process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || ''
);

function getUserId(req: VercelRequest): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  try {
    const token = authHeader.split(' ')[1];
    const decoded: any = jwt.verify(token, process.env.JWT_SECRET || process.env.SUPABASE_JWT_SECRET || '');
    return decoded.sub || decoded.user_id || null;
  } catch { return null; }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const action = req.query.action || req.body?.action;

    switch (action) {
      // ═══════════════════════════════════════
      // MARK BROKER AS RESPONDED
      // ═══════════════════════════════════════
      case 'mark-responded': {
        const { broker_id, response_text, sentiment } = req.body;
        if (!broker_id) return res.status(400).json({ error: 'broker_id required' });

        // Update the most recent campaign for this broker
        const { data: campaign } = await supabase
          .from('outreach_campaigns')
          .select('id')
          .eq('broker_id', broker_id)
          .eq('carrier_id', userId)
          .in('status', ['sent', 'delivered', 'opened'])
          .order('sent_at', { ascending: false })
          .limit(1)
          .single();

        if (campaign) {
          await supabase.from('outreach_campaigns').update({
            status: 'replied',
            replied_at: new Date().toISOString(),
            broker_response: response_text || null,
            response_sentiment: sentiment || 'neutral',
          }).eq('id', campaign.id);

          // Cancel all remaining scheduled follow-ups for this broker
          await supabase.from('outreach_campaigns').update({
            status: 'cancelled',
            error_message: 'Cancelled — broker responded',
          })
            .eq('broker_id', broker_id)
            .eq('carrier_id', userId)
            .eq('status', 'scheduled');
        }

        // Update broker CRM record
        const { data: broker } = await supabase
          .from('brokers')
          .select('total_responses, total_outreach_attempts')
          .eq('id', broker_id)
          .eq('carrier_id', userId)
          .single();

        if (broker) {
          const newResponses = (broker.total_responses || 0) + 1;
          const newRate = broker.total_outreach_attempts > 0
            ? ((newResponses / broker.total_outreach_attempts) * 100).toFixed(2)
            : 100;

          await supabase.from('brokers').update({
            outreach_status: 'responded',
            total_responses: newResponses,
            response_rate: parseFloat(newRate),
            last_contact_date: new Date().toISOString(),
          }).eq('id', broker_id);
        }

        return res.status(200).json({ message: 'Broker response recorded. Follow-ups cancelled.' });
      }

      // ═══════════════════════════════════════
      // LOG RESPONSE — Save broker's actual response
      // ═══════════════════════════════════════
      case 'log-response': {
        const { broker_id, response_text, sentiment, next_action } = req.body;
        if (!broker_id) return res.status(400).json({ error: 'broker_id required' });

        // Store response on the broker
        const updates: Record<string, any> = {
          last_contact_date: new Date().toISOString(),
        };

        if (response_text) updates.notes = response_text;
        if (next_action === 'negotiate') updates.outreach_status = 'negotiating';
        if (next_action === 'active') updates.outreach_status = 'active';
        if (next_action === 'blacklist') updates.outreach_status = 'blacklisted';

        const { data, error } = await supabase
          .from('brokers')
          .update(updates)
          .eq('id', broker_id)
          .eq('carrier_id', userId)
          .select()
          .single();

        if (error) throw error;
        return res.status(200).json({ broker: data, message: 'Response logged' });
      }

      // ═══════════════════════════════════════
      // OUTREACH STATS — Dashboard data
      // ═══════════════════════════════════════
      case 'stats': {
        // Get counts by status
        const { data: brokerStats } = await supabase
          .from('brokers')
          .select('outreach_status')
          .eq('carrier_id', userId);

        const { data: campaignStats } = await supabase
          .from('outreach_campaigns')
          .select('status, method')
          .eq('carrier_id', userId);

        // Calculate stats
        const brokerCounts: Record<string, number> = {};
        (brokerStats || []).forEach(b => {
          brokerCounts[b.outreach_status] = (brokerCounts[b.outreach_status] || 0) + 1;
        });

        const campaignCounts: Record<string, number> = {};
        (campaignStats || []).forEach(c => {
          campaignCounts[c.status] = (campaignCounts[c.status] || 0) + 1;
        });

        const totalBrokers = brokerStats?.length || 0;
        const totalCampaigns = campaignStats?.length || 0;
        const totalSent = campaignCounts['sent'] || 0;
        const totalReplied = campaignCounts['replied'] || 0;
        const responseRate = totalSent > 0 ? ((totalReplied / totalSent) * 100).toFixed(1) : '0';

        return res.status(200).json({
          stats: {
            total_brokers: totalBrokers,
            brokers_by_status: brokerCounts,
            total_campaigns: totalCampaigns,
            campaigns_by_status: campaignCounts,
            emails_sent: totalSent,
            emails_replied: totalReplied,
            overall_response_rate: `${responseRate}%`,
            pending_follow_ups: campaignCounts['scheduled'] || 0,
          }
        });
      }

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err: any) {
    console.error('[Response Track API Error]', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
