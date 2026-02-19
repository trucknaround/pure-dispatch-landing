// ============================================
// API: /api/brokers.ts
// Deploy to: pure-dispatch-landing/api/brokers.ts
// ============================================
// Handles all broker CRM operations:
//   GET    ?action=list     → List all brokers for this carrier
//   GET    ?action=get&id=  → Get single broker
//   GET    ?action=search&q= → Search brokers by name/MC
//   POST   action=create    → Add new broker
//   POST   action=update    → Update broker
//   POST   action=delete    → Delete broker
//   POST   action=log-contact → Log a contact event
// ============================================

import { createClient } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import jwt from 'jsonwebtoken';

const supabase = createClient(
  process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || ''
);

// ─────────────────────────────────────────────
// Auth Helper — extract user_id from JWT
// ─────────────────────────────────────────────
function getUserId(req: VercelRequest): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;

  try {
    const token = authHeader.split(' ')[1];
    const decoded: any = jwt.verify(
      token,
      process.env.JWT_SECRET || process.env.SUPABASE_JWT_SECRET || ''
    );
    return decoded.sub || decoded.user_id || decoded.userId || null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// Main Handler
// ─────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const userId = getUserId(req);
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const action = req.query.action || req.body?.action;

    switch (action) {
      // ═══════════════════════════════════════
      // LIST ALL BROKERS
      // ═══════════════════════════════════════
      case 'list': {
        const { status, sort, limit } = req.query;
        let query = supabase
          .from('brokers')
          .select('*')
          .eq('carrier_id', userId);

        if (status && status !== 'all') {
          query = query.eq('outreach_status', status);
        }

        if (sort === 'score') {
          query = query.order('relationship_score', { ascending: false });
        } else if (sort === 'recent') {
          query = query.order('last_contact_date', { ascending: false, nullsFirst: false });
        } else if (sort === 'revenue') {
          query = query.order('total_revenue', { ascending: false });
        } else {
          query = query.order('created_at', { ascending: false });
        }

        if (limit) {
          query = query.limit(parseInt(limit as string, 10));
        }

        const { data, error } = await query;
        if (error) throw error;

        return res.status(200).json({ brokers: data, count: data?.length || 0 });
      }

      // ═══════════════════════════════════════
      // GET SINGLE BROKER
      // ═══════════════════════════════════════
      case 'get': {
        const brokerId = req.query.id;
        if (!brokerId) return res.status(400).json({ error: 'id required' });

        const { data, error } = await supabase
          .from('brokers')
          .select('*')
          .eq('id', brokerId)
          .eq('carrier_id', userId)
          .single();

        if (error) throw error;
        return res.status(200).json({ broker: data });
      }

      // ═══════════════════════════════════════
      // SEARCH BROKERS
      // ═══════════════════════════════════════
      case 'search': {
        const q = req.query.q as string;
        if (!q) return res.status(400).json({ error: 'q (search query) required' });

        const { data, error } = await supabase
          .from('brokers')
          .select('*')
          .eq('carrier_id', userId)
          .or(`company_name.ilike.%${q}%,mc_number.ilike.%${q}%,contact_name.ilike.%${q}%,email.ilike.%${q}%`)
          .order('relationship_score', { ascending: false })
          .limit(20);

        if (error) throw error;
        return res.status(200).json({ brokers: data, count: data?.length || 0 });
      }

      // ═══════════════════════════════════════
      // CREATE BROKER
      // ═══════════════════════════════════════
      case 'create': {
        const body = req.body;
        if (!body.company_name) {
          return res.status(400).json({ error: 'company_name required' });
        }

        const brokerData = {
          carrier_id: userId,
          company_name: body.company_name,
          contact_name: body.contact_name || null,
          mc_number: body.mc_number || null,
          dot_number: body.dot_number || null,
          email: body.email || null,
          phone: body.phone || null,
          fax: body.fax || null,
          website: body.website || null,
          address_street: body.address_street || null,
          address_city: body.address_city || null,
          address_state: body.address_state || null,
          address_zip: body.address_zip || null,
          authority_status: body.authority_status || 'unknown',
          days_to_pay: body.days_to_pay || null,
          payment_method: body.payment_method || null,
          credit_score: body.credit_score || null,
          notes: body.notes || null,
          tags: body.tags || [],
          preferred_lanes: body.preferred_lanes || [],
          source: body.source || 'manual',
        };

        const { data, error } = await supabase
          .from('brokers')
          .insert(brokerData)
          .select()
          .single();

        if (error) {
          // Handle duplicate MC
          if (error.code === '23505') {
            return res.status(409).json({ error: 'Broker with this MC number already exists in your CRM' });
          }
          throw error;
        }

        return res.status(201).json({ broker: data, message: 'Broker added to CRM' });
      }

      // ═══════════════════════════════════════
      // UPDATE BROKER
      // ═══════════════════════════════════════
      case 'update': {
        const body = req.body;
        if (!body.id) return res.status(400).json({ error: 'id required' });

        // Remove fields that shouldn't be manually updated
        const { id, carrier_id, created_at, ...updateFields } = body;

        const { data, error } = await supabase
          .from('brokers')
          .update(updateFields)
          .eq('id', body.id)
          .eq('carrier_id', userId)
          .select()
          .single();

        if (error) throw error;
        return res.status(200).json({ broker: data, message: 'Broker updated' });
      }

      // ═══════════════════════════════════════
      // DELETE BROKER
      // ═══════════════════════════════════════
      case 'delete': {
        const body = req.body;
        if (!body.id) return res.status(400).json({ error: 'id required' });

        const { error } = await supabase
          .from('brokers')
          .delete()
          .eq('id', body.id)
          .eq('carrier_id', userId);

        if (error) throw error;
        return res.status(200).json({ message: 'Broker deleted' });
      }

      // ═══════════════════════════════════════
      // LOG CONTACT EVENT
      // ═══════════════════════════════════════
      case 'log-contact': {
        const body = req.body;
        if (!body.id) return res.status(400).json({ error: 'broker id required' });

        const { data: broker } = await supabase
          .from('brokers')
          .select('total_outreach_attempts, total_responses, outreach_status, first_contact_date')
          .eq('id', body.id)
          .eq('carrier_id', userId)
          .single();

        if (!broker) return res.status(404).json({ error: 'Broker not found' });

        const updates: Record<string, any> = {
          last_contact_date: new Date().toISOString(),
          total_outreach_attempts: (broker.total_outreach_attempts || 0) + 1,
        };

        if (!broker.first_contact_date) {
          updates.first_contact_date = new Date().toISOString();
        }

        if (body.responded) {
          updates.total_responses = (broker.total_responses || 0) + 1;
          updates.outreach_status = 'responded';
          // Recalculate response rate
          updates.response_rate = ((updates.total_responses / updates.total_outreach_attempts) * 100).toFixed(2);
        } else if (broker.outreach_status === 'new') {
          updates.outreach_status = 'contacted';
        }

        if (body.notes) {
          updates.notes = body.notes;
        }

        const { data, error } = await supabase
          .from('brokers')
          .update(updates)
          .eq('id', body.id)
          .eq('carrier_id', userId)
          .select()
          .single();

        if (error) throw error;
        return res.status(200).json({ broker: data, message: 'Contact logged' });
      }

      // ═══════════════════════════════════════
      // IMPORT FROM LEAD (move a broker_lead into your CRM)
      // ═══════════════════════════════════════
      case 'import-lead': {
        const body = req.body;
        if (!body.lead_id) return res.status(400).json({ error: 'lead_id required' });

        // Fetch the lead
        const { data: lead, error: leadErr } = await supabase
          .from('broker_leads')
          .select('*')
          .eq('id', body.lead_id)
          .single();

        if (leadErr || !lead) {
          return res.status(404).json({ error: 'Lead not found' });
        }

        // Check if already in CRM
        if (lead.mc_number) {
          const { data: existing } = await supabase
            .from('brokers')
            .select('id')
            .eq('mc_number', lead.mc_number)
            .eq('carrier_id', userId)
            .single();

          if (existing) {
            return res.status(409).json({ error: 'Broker already in your CRM', broker_id: existing.id });
          }
        }

        // Create broker from lead
        const brokerData = {
          carrier_id: userId,
          company_name: lead.legal_name,
          contact_name: lead.dba_name || null,
          mc_number: lead.mc_number,
          dot_number: lead.dot_number,
          email: lead.email || null,
          phone: lead.phone || null,
          fax: lead.fax || null,
          website: lead.website || null,
          address_street: lead.address_street || null,
          address_city: lead.address_city || null,
          address_state: lead.address_state || null,
          address_zip: lead.address_zip || null,
          authority_status: lead.authority_status || 'unknown',
          credit_score: lead.estimated_credit_score || null,
          days_to_pay: lead.estimated_days_to_pay || null,
          source: 'fmcsa_import',
        };

        const { data, error } = await supabase
          .from('brokers')
          .insert(brokerData)
          .select()
          .single();

        if (error) throw error;
        return res.status(201).json({ broker: data, message: 'Lead imported to CRM' });
      }

      default:
        return res.status(400).json({ error: `Unknown action: ${action}. Use: list, get, search, create, update, delete, log-contact, import-lead` });
    }
  } catch (err: any) {
    console.error('[Brokers API Error]', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
