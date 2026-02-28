// Vercel Serverless Function — Job Refresh via JSearch API
// Runs on schedule (weekly) or on-demand via GET /api/refresh
// Searches for Denver engineering jobs, matches against Supabase company list, updates active roles

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const SB_URL = 'https://acwgirrldntjpzrhqmdh.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

// Job search queries — covers the target roles
const SEARCHES = [
  'mechanical engineer Denver Colorado',
  'design engineer manufacturing engineer Denver Colorado',
  'HVAC MEP engineer Denver Colorado',
  'fabrication CAD prototype engineer Denver Colorado',
  'structural engineer EIT Denver Colorado',
];

async function searchJobs(query) {
  const url = `https://jsearch.p.rapidapi.com/search?query=${encodeURIComponent(query)}&page=1&num_pages=2&country=us&date_posted=month`;
  const res = await fetch(url, {
    headers: {
      'x-rapidapi-key': RAPIDAPI_KEY,
      'x-rapidapi-host': 'jsearch.p.rapidapi.com'
    }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`JSearch API error ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.data || [];
}

async function getCompanies() {
  const all = [];
  let offset = 0;
  while (true) {
    const res = await fetch(
      `${SB_URL}/rest/v1/companies?select=id,companyname,tier,activerole&order=id&offset=${offset}&limit=1000`,
      { headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` } }
    );
    const batch = await res.json();
    all.push(...batch);
    if (batch.length < 1000) break;
    offset += 1000;
  }
  return all;
}

function normalize(name) {
  return name.toLowerCase()
    .replace(/[,.\-()]+/g, ' ')
    .replace(/\s+(inc|llc|corp|co|ltd|engineering|engineers|group|company|technologies|consulting)\.?$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchCompany(employerName, dbCompanies) {
  const normalized = normalize(employerName);
  // Strict match: normalized names must be equal, or one must be a complete word-boundary match
  for (const c of dbCompanies) {
    const dbNorm = normalize(c.companyname);
    if (dbNorm === normalized) return c;
    // Allow match if shorter name is 5+ chars AND equals start of longer name
    if (dbNorm.length >= 5 && normalized.startsWith(dbNorm + ' ')) return c;
    if (normalized.length >= 5 && dbNorm.startsWith(normalized + ' ')) return c;
    // Exact substring only if the shorter name is 8+ chars (avoid "Intel" matching "Intellivation")
    if (dbNorm.length >= 8 && normalized.includes(dbNorm)) return c;
    if (normalized.length >= 8 && dbNorm.includes(normalized)) return c;
  }
  return null;
}

async function updateCompany(companyname) {
  await fetch(
    `${SB_URL}/rest/v1/companies?companyname=eq.${encodeURIComponent(companyname)}`,
    {
      method: 'PATCH',
      headers: {
        'apikey': SB_KEY,
        'Authorization': `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ activerole: true })
    }
  );
}

async function updateTracking(companyname) {
  await fetch(
    `${SB_URL}/rest/v1/tracking?companyname=eq.${encodeURIComponent(companyname)}`,
    {
      method: 'PATCH',
      headers: {
        'apikey': SB_KEY,
        'Authorization': `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ status: 'opening', lastchecked: new Date().toISOString() })
    }
  );
}

export default async function handler(req, res) {
  if (!RAPIDAPI_KEY || !SB_KEY) {
    return res.status(500).json({ error: 'Missing RAPIDAPI_KEY or SUPABASE_SERVICE_KEY env vars' });
  }

  try {
    // 1. Load all companies from Supabase
    const dbCompanies = await getCompanies();

    // 2. Search all job queries (5 searches = 10 API calls with 2 pages each)
    const allJobs = [];
    for (const query of SEARCHES) {
      const jobs = await searchJobs(query);
      allJobs.push(...jobs);
    }

    // 3. Deduplicate by employer
    const employers = new Map();
    for (const job of allJobs) {
      const name = job.employer_name;
      if (name && !employers.has(name.toLowerCase())) {
        employers.set(name.toLowerCase(), {
          name,
          title: job.job_title,
          location: job.job_city,
          url: job.job_apply_link
        });
      }
    }

    // 4. Match against database
    const matched = [];
    const notFound = [];

    for (const [, emp] of employers) {
      const match = matchCompany(emp.name, dbCompanies);
      if (match) {
        matched.push({ search: emp.name, db: match.companyname, tier: match.tier });
        await updateCompany(match.companyname);
        await updateTracking(match.companyname);
      } else {
        notFound.push(emp);
      }
    }

    const result = {
      timestamp: new Date().toISOString(),
      totalJobsFound: allJobs.length,
      uniqueEmployers: employers.size,
      matchedInDB: matched.length,
      notInDB: notFound.length,
      matches: matched,
      newCompanies: notFound.slice(0, 20) // cap output
    };

    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
