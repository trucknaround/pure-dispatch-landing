// ============================================
// API: /api/fmcsa-directory.ts
// Deploy to: pure-dispatch-landing/api/fmcsa-directory.ts
// ============================================
// Imports broker data from FMCSA's public API into the broker_leads table.
// Carriers can search this table and import leads into their personal CRM.
//
//   GET ?action=search&q=  → Search broker leads by name/MC/state
//   GET ?action=import-mc&mc= → Import a single broker by MC number from FMCSA
//   POST action=bulk-import&state= → Bulk import active brokers from a state
// ============================================

import { createClient } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import jwt from 'jsonwebtoken';
import axios from 'axios';

const supabase = createClient(
  process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || ''
);

const FMCSA_API_KEY = process.env.FMCSA_API_KEY || '';
const FMCSA_BASE_URL = 'https://mobile.fmcsa.dot.gov/qc/services';
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
// Fetch single carrier from FMCSA by MC number
// ─────────────────────────────────────────────
async function fetchFromFMCSA(mcNumber: string): Promise<any | null> {
  try {
    // FMCSA API: lookup by docket (MC) number
    const url = `${FMCSA_BASE_URL}/carriers/docket-number/${mcNumber}?webKey=${FMCSA_API_KEY}`;
    const response = await axios.get(url, { timeout: 10000 });

    if (!response.data?.content || response.data.content.length === 0) {
      return null;
    }

    const carrier = response.data.content[0].carrier;
    return {
      mc_number: mcNumber,
      dot_number: carrier.dotNumber?.toString() || null,
      legal_name: carrier.legalName || 'Unknown',
      dba_name: carrier.dbaName || null,
      phone: carrier.phyPhone || null,
      fax: carrier.fax || null,
      address_street: carrier.phyStreet || null,
      address_city: carrier.phyCity || null,
      address_state: carrier.phyState || null,
      address_zip: carrier.phyZipcode || null,
      authority_status: carrier.allowedToOperate === 'Y' ? 'ACTIVE' : 'INACTIVE',
      authority_type: carrier.brokerAuthorityStatus === 'A' ? 'broker' : 'carrier',
      broker_authority: carrier.brokerAuthorityStatus === 'A',
      common_authority: carrier.commonAuthorityStatus === 'A',
      contract_authority: carrier.contractAuthorityStatus === 'A',
      operation_classification: carrier.operationClassification || null,
      cargo_carried: carrier.cargoCarried ? carrier.cargoCarried.split(',').map((c: string) => c.trim()) : [],
    };
  } catch (err: any) {
    console.error(`[FMCSA] Error fetching MC ${mcNumber}:`, err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// Fetch carriers by name search
// ─────────────────────────────────────────────
async function searchFMCSA(query: string): Promise<any[]> {
  try {
    const url = `${FMCSA_BASE_URL}/carriers/name/${encodeURIComponent(query)}?webKey=${FMCSA_API_KEY}`;
    const response = await axios.get(url, { timeout: 15000 });

    if (!response.data?.content || response.data.content.length === 0) {
      return [];
    }

    return response.data.content
      .filter((item: any) => item.carrier?.brokerAuthorityStatus === 'A')
      .slice(0, 50)
      .map((item: any) => {
        const c = item.carrier;
        return {
          mc_number: c.mcNumber?.toString() || null,
          dot_number: c.dotNumber?.toString() || null,
          legal_name: c.legalName || 'Unknown',
          dba_name: c.dbaName || null,
          phone: c.phyPhone || null,
          address_city: c.phyCity || null,
          address_state: c.phyState || null,
          authority_status: c.allowedToOperate === 'Y' ? 'ACTIVE' : 'INACTIVE',
          broker_authority: true,
        };
      });
  } catch (err: any) {
    console.error(`[FMCSA] Search error for "${query}":`, err.message);
    return [];
  }
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
      // SEARCH — Search existing broker_leads table
      // ═══════════════════════════════════════
      case 'search': {
        const q = req.query.q as string;
        const state = req.query.state as string;

        if (!q && !state) {
          return res.status(400).json({ error: 'Provide q (search term) or state filter' });
        }

        let query = supabase
          .from('broker_leads')
          .select('*')
          .eq('authority_status', 'ACTIVE')
          .eq('broker_authority', true);

        if (q) {
          query = query.or(`legal_name.ilike.%${q}%,mc_number.ilike.%${q}%,dba_name.ilike.%${q}%`);
        }
        if (state) {
          query = query.eq('address_state', state.toUpperCase());
        }

        query = query.order('legal_name').limit(50);

        const { data, error } = await query;
        if (error) throw error;

        return res.status(200).json({ leads: data, count: data?.length || 0 });
      }

      // ═══════════════════════════════════════
      // IMPORT-MC — Import a single broker from FMCSA by MC#
      // ═══════════════════════════════════════
      case 'import-mc': {
        const mc = (req.query.mc as string)?.replace(/^MC-?/i, '').trim();
        if (!mc) return res.status(400).json({ error: 'mc number required' });

        // Check if already in leads table
        const { data: existing } = await supabase
          .from('broker_leads')
          .select('id, legal_name, mc_number')
          .eq('mc_number', mc)
          .single();

        if (existing) {
          return res.status(200).json({
            lead: existing,
            message: 'Broker already in leads database',
            already_imported: true
          });
        }

        // Fetch from FMCSA
        const fmcsaData = await fetchFromFMCSA(mc);
        if (!fmcsaData) {
          return res.status(404).json({ error: `No broker found for MC ${mc} in FMCSA database` });
        }

        // Insert into broker_leads
        const { data, error } = await supabase
          .from('broker_leads')
          .insert({
            ...fmcsaData,
            source: 'fmcsa_api',
            last_verified_at: new Date().toISOString(),
          })
          .select()
          .single();

        if (error) throw error;
        return res.status(201).json({ lead: data, message: 'Broker imported from FMCSA' });
      }

      // ═══════════════════════════════════════
      // LIVE-SEARCH — Search FMCSA API directly (not our database)
      // ═══════════════════════════════════════
      case 'live-search': {
        const q = req.query.q as string;
        if (!q || q.length < 2) {
          return res.status(400).json({ error: 'Search query must be at least 2 characters' });
        }

        if (!FMCSA_API_KEY) {
          return res.status(503).json({ error: 'FMCSA API key not configured. Add FMCSA_API_KEY to environment variables.' });
        }

        const results = await searchFMCSA(q);
        return res.status(200).json({ results, count: results.length, source: 'fmcsa_live' });
      }

      // ═══════════════════════════════════════
      // BULK-IMPORT — Import active brokers from FMCSA by name search
      // ═══════════════════════════════════════
      case 'bulk-import': {
        const q = req.body?.q as string;
        if (!q) return res.status(400).json({ error: 'q (search term) required in body' });

        if (!FMCSA_API_KEY) {
          return res.status(503).json({ error: 'FMCSA API key not configured' });
        }

        const results = await searchFMCSA(q);
        if (results.length === 0) {
          return res.status(200).json({ imported: 0, message: 'No brokers found matching that search' });
        }

        // Filter out ones we already have
        const mcNumbers = results.filter(r => r.mc_number).map(r => r.mc_number);
        const { data: existing } = await supabase
          .from('broker_leads')
          .select('mc_number')
          .in('mc_number', mcNumbers);

        const existingMCs = new Set((existing || []).map(e => e.mc_number));
        const newLeads = results.filter(r => r.mc_number && !existingMCs.has(r.mc_number));

        if (newLeads.length === 0) {
          return res.status(200).json({ imported: 0, message: 'All found brokers already in database' });
        }

        // Insert new leads
        const toInsert = newLeads.map(lead => ({
          ...lead,
          source: 'fmcsa_api',
          last_verified_at: new Date().toISOString(),
        }));

        const { data, error } = await supabase
          .from('broker_leads')
          .insert(toInsert)
          .select('id, legal_name, mc_number');

        if (error) throw error;

        return res.status(201).json({
          imported: data?.length || 0,
          leads: data,
          message: `Imported ${data?.length} new brokers from FMCSA`
        });
      }

      default:
        return res.status(400).json({
          error: `Unknown action: ${action}. Use: search, import-mc, live-search, bulk-import`
        });
    }
  } catch (err: any) {
    console.error('[FMCSA Directory API Error]', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
