// ============================================
// API: /api/lane-targeting.ts
// Deploy to: pure-dispatch-landing/api/lane-targeting.ts
// ============================================
// Recommends which brokers to target based on:
//   - Carrier's home base + equipment + preferred lanes
//   - Broker's location + preferred lanes + authority status
//   - Relationship history (never contacted, low response, high value)
//
//   GET ?action=recommendations → Get ranked broker targets
//   GET ?action=lane-analysis   → Analyze which lanes have most broker coverage
// ============================================

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
    const token = authHeader.substring(7);
    const base64Payload = token.split('.')[1];
    const payload = JSON.parse(Buffer.from(base64Payload, 'base64').toString('utf-8'));
    
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    
    return payload.userId || null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// US State adjacency map — for finding nearby brokers
// ─────────────────────────────────────────────
const STATE_NEIGHBORS: Record<string, string[]> = {
  'NJ': ['NY', 'PA', 'DE'],
  'NY': ['NJ', 'PA', 'CT', 'MA', 'VT'],
  'PA': ['NJ', 'NY', 'DE', 'MD', 'WV', 'OH'],
  'DE': ['NJ', 'PA', 'MD'],
  'MD': ['PA', 'DE', 'WV', 'VA', 'DC'],
  'VA': ['MD', 'DC', 'WV', 'KY', 'TN', 'NC'],
  'NC': ['VA', 'TN', 'SC', 'GA'],
  'SC': ['NC', 'GA'],
  'GA': ['SC', 'NC', 'TN', 'AL', 'FL'],
  'FL': ['GA', 'AL'],
  'AL': ['TN', 'GA', 'FL', 'MS'],
  'MS': ['TN', 'AL', 'AR', 'LA'],
  'LA': ['MS', 'AR', 'TX'],
  'TX': ['LA', 'AR', 'OK', 'NM'],
  'OK': ['TX', 'AR', 'MO', 'KS', 'CO', 'NM'],
  'AR': ['MO', 'TN', 'MS', 'LA', 'TX', 'OK'],
  'TN': ['KY', 'VA', 'NC', 'GA', 'AL', 'MS', 'AR', 'MO'],
  'KY': ['OH', 'WV', 'VA', 'TN', 'MO', 'IL', 'IN'],
  'WV': ['OH', 'PA', 'MD', 'VA', 'KY'],
  'OH': ['PA', 'WV', 'KY', 'IN', 'MI'],
  'MI': ['OH', 'IN', 'WI'],
  'IN': ['OH', 'KY', 'IL', 'MI'],
  'IL': ['WI', 'IN', 'KY', 'MO', 'IA'],
  'WI': ['MI', 'IL', 'IA', 'MN'],
  'MN': ['WI', 'IA', 'ND', 'SD'],
  'IA': ['MN', 'WI', 'IL', 'MO', 'NE', 'SD'],
  'MO': ['IA', 'IL', 'KY', 'TN', 'AR', 'OK', 'KS', 'NE'],
  'KS': ['NE', 'MO', 'OK', 'CO'],
  'NE': ['SD', 'IA', 'MO', 'KS', 'CO', 'WY'],
  'SD': ['ND', 'MN', 'IA', 'NE', 'WY', 'MT'],
  'ND': ['MN', 'SD', 'MT'],
  'MT': ['ND', 'SD', 'WY', 'ID'],
  'WY': ['MT', 'SD', 'NE', 'CO', 'UT', 'ID'],
  'CO': ['WY', 'NE', 'KS', 'OK', 'NM', 'UT'],
  'NM': ['CO', 'OK', 'TX', 'AZ'],
  'AZ': ['NM', 'UT', 'NV', 'CA'],
  'UT': ['WY', 'CO', 'NM', 'AZ', 'NV', 'ID'],
  'NV': ['OR', 'ID', 'UT', 'AZ', 'CA'],
  'CA': ['OR', 'NV', 'AZ'],
  'OR': ['WA', 'ID', 'NV', 'CA'],
  'WA': ['OR', 'ID'],
  'ID': ['WA', 'OR', 'NV', 'UT', 'WY', 'MT'],
  'CT': ['NY', 'MA', 'RI'],
  'MA': ['NY', 'CT', 'RI', 'NH', 'VT'],
  'RI': ['CT', 'MA'],
  'NH': ['MA', 'VT', 'ME'],
  'VT': ['NY', 'MA', 'NH'],
  'ME': ['NH'],
  'DC': ['MD', 'VA'],
};

// ─────────────────────────────────────────────
// Scoring algorithm
// ─────────────────────────────────────────────
function scoreBrokerTarget(
  broker: any,
  carrier: any,
  carrierState: string
): { score: number; reasons: string[] } {
  let score = 50; // Base score
  const reasons: string[] = [];

  // 1. Geographic proximity
  const brokerState = broker.address_state?.toUpperCase();
  if (brokerState === carrierState) {
    score += 20;
    reasons.push('Same state as home base');
  } else if (STATE_NEIGHBORS[carrierState]?.includes(brokerState)) {
    score += 10;
    reasons.push('Neighboring state');
  }

  // 2. Lane overlap
  const carrierLanes = carrier.preferred_lanes || [];
  const brokerLanes = broker.preferred_lanes || [];
  if (carrierLanes.length > 0 && brokerLanes.length > 0) {
    const overlap = carrierLanes.filter((l: string) =>
      brokerLanes.some((bl: string) => bl.includes(l) || l.includes(bl))
    );
    if (overlap.length > 0) {
      score += overlap.length * 10;
      reasons.push(`${overlap.length} matching lane(s)`);
    }
  }

  // 3. Broker quality signals
  if (broker.authority_status === 'ACTIVE' || broker.authority_status === 'active') {
    score += 5;
  }
  if (broker.credit_score && broker.credit_score >= 90) {
    score += 10;
    reasons.push('High credit score');
  } else if (broker.credit_score && broker.credit_score < 80) {
    score -= 15;
    reasons.push('Low credit score — risky');
  }

  if (broker.days_to_pay && broker.days_to_pay <= 15) {
    score += 10;
    reasons.push('Quick pay (≤15 days)');
  } else if (broker.days_to_pay && broker.days_to_pay > 45) {
    score -= 5;
    reasons.push('Slow pay (45+ days)');
  }

  // 4. Never contacted = opportunity
  if (broker.outreach_status === 'new' || !broker.outreach_status) {
    score += 5;
    reasons.push('Not yet contacted');
  }

  // 5. Previous success with this broker
  if (broker.total_loads_booked > 0) {
    score += broker.total_loads_booked * 5;
    reasons.push(`${broker.total_loads_booked} loads booked previously`);
  }

  // 6. Response rate bonus
  if (broker.response_rate > 50) {
    score += 10;
    reasons.push('High response rate');
  }

  // Cap at 100
  return { score: Math.min(100, Math.max(0, score)), reasons };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const action = req.query.action || 'recommendations';

    switch (action) {
      // ═══════════════════════════════════════
      // RECOMMENDATIONS — Who should the carrier contact?
      // ═══════════════════════════════════════
      case 'recommendations': {
        // Get carrier profile
        const { data: carrier } = await supabase
          .from('carrier_profiles')
          .select('*')
          .eq('user_id', userId)
          .single();

        if (!carrier) {
          return res.status(400).json({
            error: 'Carrier profile required for lane targeting. Set up your home base, equipment, and preferred lanes first.'
          });
        }

        const carrierState = carrier.home_base_state?.toUpperCase() || '';
        const neighborStates = STATE_NEIGHBORS[carrierState] || [];
        const targetStates = [carrierState, ...neighborStates];

        // Get brokers in CRM
        const { data: crmBrokers } = await supabase
          .from('brokers')
          .select('*')
          .eq('carrier_id', userId)
          .not('outreach_status', 'eq', 'blacklisted');

        // Get broker leads in target states
        const { data: leads } = await supabase
          .from('broker_leads')
          .select('*')
          .in('address_state', targetStates)
          .eq('authority_status', 'ACTIVE')
          .eq('broker_authority', true)
          .limit(100);

        // Score CRM brokers
        const scoredCRM = (crmBrokers || []).map(broker => {
          const { score, reasons } = scoreBrokerTarget(broker, carrier, carrierState);
          return { ...broker, target_score: score, target_reasons: reasons, source: 'crm' };
        });

        // Score leads (not yet in CRM)
        const crmMCs = new Set((crmBrokers || []).map(b => b.mc_number).filter(Boolean));
        const newLeads = (leads || [])
          .filter(l => !crmMCs.has(l.mc_number))
          .map(lead => {
            const { score, reasons } = scoreBrokerTarget(lead, carrier, carrierState);
            return { ...lead, target_score: score, target_reasons: reasons, source: 'lead' };
          });

        // Combine and sort by score
        const allTargets = [...scoredCRM, ...newLeads]
          .sort((a, b) => b.target_score - a.target_score)
          .slice(0, 30);

        return res.status(200).json({
          recommendations: allTargets,
          carrier_state: carrierState,
          target_states: targetStates,
          total_crm: crmBrokers?.length || 0,
          total_leads: leads?.length || 0,
        });
      }

      // ═══════════════════════════════════════
      // LANE ANALYSIS — Which lanes have the most broker coverage?
      // ═══════════════════════════════════════
      case 'lane-analysis': {
        const { data: carrier } = await supabase
          .from('carrier_profiles')
          .select('preferred_lanes, preferred_states, home_base_state')
          .eq('user_id', userId)
          .single();

        if (!carrier) {
          return res.status(400).json({ error: 'Carrier profile required' });
        }

        const lanes = carrier.preferred_lanes || [];
        const analysis: Array<{
          lane: string;
          brokers_in_crm: number;
          leads_available: number;
          coverage: string;
        }> = [];

        for (const lane of lanes) {
          // Parse lane (e.g., "NJ-FL" → states NJ and FL)
          const states = lane.split('-').map((s: string) => s.trim().toUpperCase());

          // Count CRM brokers in these states
          let crmQuery = supabase
            .from('brokers')
            .select('id', { count: 'exact', head: true })
            .eq('carrier_id', userId);
          
          if (states.length >= 2) {
            crmQuery = crmQuery.or(`address_state.eq.${states[0]},address_state.eq.${states[1]}`);
          } else if (states.length === 1) {
            crmQuery = crmQuery.eq('address_state', states[0]);
          }

          const { count: crmCount } = await crmQuery;

          // Count leads in these states
          let leadsQuery = supabase
            .from('broker_leads')
            .select('id', { count: 'exact', head: true })
            .eq('authority_status', 'ACTIVE');

          if (states.length >= 2) {
            leadsQuery = leadsQuery.or(`address_state.eq.${states[0]},address_state.eq.${states[1]}`);
          } else if (states.length === 1) {
            leadsQuery = leadsQuery.eq('address_state', states[0]);
          }

          const { count: leadsCount } = await leadsQuery;

          const total = (crmCount || 0) + (leadsCount || 0);
          const coverage = total > 20 ? 'HIGH' : total > 5 ? 'MEDIUM' : 'LOW';

          analysis.push({
            lane,
            brokers_in_crm: crmCount || 0,
            leads_available: leadsCount || 0,
            coverage,
          });
        }

        return res.status(200).json({
          lane_analysis: analysis,
          suggestion: analysis.some(a => a.coverage === 'LOW')
            ? 'Some lanes have low broker coverage. Consider importing more leads from FMCSA for those regions.'
            : 'Good broker coverage across your lanes.',
        });
      }

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err: any) {
    console.error('[Lane Targeting API Error]', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
