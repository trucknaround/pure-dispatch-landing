// ============================================
// API: /api/broker-score.ts
// Deploy to: pure-dispatch-landing/api/broker-score.ts
// ============================================

import { createClient } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import jwt from 'jsonwebtoken';

const supabase = createClient(
  process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || ''
);

function getUserId(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;

  try {
    const token = authHeader.substring(7);
    const base64Payload = token.split('.')[1];
    const payload = JSON.parse(Buffer.from(base64Payload, 'base64').toString('utf-8'));
    
    // Check expiration
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    
    return payload.userId || null;
  } catch {
    return null;
  }
}

function calculateRelationshipScore(broker: any): { score: number; breakdown: Record<string, number> } {
  const breakdown: Record<string, number> = {};
  
  // Payment reliability (0-25)
  let paymentScore = 15;
  if (broker.credit_score) {
    if (broker.credit_score >= 95) paymentScore = 25;
    else if (broker.credit_score >= 90) paymentScore = 22;
    else if (broker.credit_score >= 85) paymentScore = 18;
    else if (broker.credit_score >= 80) paymentScore = 12;
    else paymentScore = 5;
  }
  if (broker.days_to_pay) {
    if (broker.days_to_pay <= 7) paymentScore = Math.min(25, paymentScore + 5);
    else if (broker.days_to_pay <= 15) paymentScore = Math.min(25, paymentScore + 3);
    else if (broker.days_to_pay > 45) paymentScore = Math.max(0, paymentScore - 5);
  }
  breakdown.payment = paymentScore;

  // Responsiveness (0-25)
  let responseScore = 10;
  if (broker.response_rate > 80) responseScore = 25;
  else if (broker.response_rate > 50) responseScore = 20;
  else if (broker.response_rate > 25) responseScore = 15;
  else if (broker.response_rate > 0) responseScore = 8;
  else if (broker.total_outreach_attempts > 3 && broker.total_responses === 0) responseScore = 2;

  if (broker.last_contact_date) {
    const daysSince = Math.floor((Date.now() - new Date(broker.last_contact_date).getTime()) / (1000 * 60 * 60 * 24));
    if (daysSince <= 7) responseScore = Math.min(25, responseScore + 5);
    else if (daysSince <= 30) responseScore = Math.min(25, responseScore + 2);
    else if (daysSince > 90) responseScore = Math.max(0, responseScore - 3);
  }
  breakdown.responsiveness = responseScore;

  // Revenue history (0-25)
  let revenueScore = 0;
  if (broker.total_loads_booked >= 10) revenueScore = 25;
  else if (broker.total_loads_booked >= 5) revenueScore = 20;
  else if (broker.total_loads_booked >= 2) revenueScore = 15;
  else if (broker.total_loads_booked >= 1) revenueScore = 10;
  breakdown.revenue = revenueScore;

  // Reliability signals (0-25)
  let reliabilityScore = 10;
  if (broker.authority_status === 'active' || broker.authority_status === 'ACTIVE') reliabilityScore += 8;
  if (broker.insurance_on_file) reliabilityScore += 4;
  if (broker.outreach_status === 'active') reliabilityScore += 3;
  if (broker.outreach_status === 'blacklisted') reliabilityScore = 0;
  reliabilityScore = Math.min(25, reliabilityScore);
  breakdown.reliability = reliabilityScore;

  const total = Math.min(100, paymentScore + responseScore + revenueScore + reliabilityScore);
  return { score: total, breakdown };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const action = req.query.action || 'top-brokers';

    switch (action) {
      case 'score-all': {
        const { data: brokers, error } = await supabase
          .from('brokers')
          .select('*')
          .eq('carrier_id', userId);

        if (error) throw error;
        if (!brokers || brokers.length === 0) {
          return res.status(200).json({ message: 'No brokers in CRM', updated: 0 });
        }

        let updated = 0;
        for (const broker of brokers) {
          const { score } = calculateRelationshipScore(broker);
          await supabase.from('brokers').update({ relationship_score: score }).eq('id', broker.id);
          updated++;
        }

        return res.status(200).json({ message: `Scored ${updated} brokers`, updated });
      }

      case 'score': {
        const brokerId = req.query.id;
        if (!brokerId) return res.status(400).json({ error: 'id required' });

        const { data: broker } = await supabase
          .from('brokers')
          .select('*')
          .eq('id', brokerId)
          .eq('carrier_id', userId)
          .single();

        if (!broker) return res.status(404).json({ error: 'Broker not found' });

        const { score, breakdown } = calculateRelationshipScore(broker);
        await supabase.from('brokers').update({ relationship_score: score }).eq('id', broker.id);

        return res.status(200).json({
          broker_id: broker.id,
          company: broker.company_name,
          score,
          breakdown,
          label: score >= 80 ? 'EXCELLENT' : score >= 60 ? 'GOOD' : score >= 40 ? 'FAIR' : 'POOR',
        });
      }

      case 'top-brokers': {
        const limit = parseInt(req.query.limit as string, 10) || 10;

        const { data, error } = await supabase
          .from('brokers')
          .select('id, company_name, mc_number, relationship_score, total_loads_booked, total_revenue, response_rate, outreach_status, last_contact_date')
          .eq('carrier_id', userId)
          .order('relationship_score', { ascending: false })
          .limit(limit);

        if (error) throw error;
        return res.status(200).json({ brokers: data });
      }

      case 'needs-attention': {
        const { data, error } = await supabase
          .from('brokers')
          .select('id, company_name, mc_number, outreach_status, last_contact_date, total_outreach_attempts, response_rate')
          .eq('carrier_id', userId)
          .not('outreach_status', 'eq', 'blacklisted');

        if (error) throw error;

        const now = Date.now();
        const needsAttention = (data || []).filter(b => {
          // Never contacted
          if (!b.last_contact_date) return true;
          // Last contact > 14 days ago and still in 'contacted' status
          const daysSince = Math.floor((now - new Date(b.last_contact_date).getTime()) / (1000 * 60 * 60 * 24));
          if (daysSince > 14 && b.outreach_status === 'contacted') return true;
          // Responded but no action taken
          if (b.outreach_status === 'responded') return true;
          return false;
        }).sort((a, b) => {
          // Responded brokers first, then never contacted, then stale
          const priority = (s: string) => s === 'responded' ? 0 : s === 'new' ? 1 : 2;
          return priority(a.outreach_status) - priority(b.outreach_status);
        });

        return res.status(200).json({
          brokers: needsAttention,
          count: needsAttention.length,
          message: needsAttention.length > 0
            ? `${needsAttention.length} broker(s) need attention`
            : 'All brokers are up to date',
        });
      }

      default:
        return res.status(400).json({ error: `Unknown action: ${action}. Use: score-all, score, top-brokers, needs-attention` });
    }
  } catch (err: any) {
    console.error('[Broker Score API Error]', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
