-- Databases seeded before the demo labels were removed from seed.js still carry "(Demo)" names,
-- "DEMO / PILOT DATA" notes and "Demo:" prefixes. Bring those rows in line with the current seed.
-- Every statement only touches rows that still have the old text, so it is safe on any database.

UPDATE farms SET name = 'ComCrop Singapore', slug = 'comcrop-singapore',
  description = 'Urban farm in Singapore growing leafy greens and herbs for restaurants, retailers and neighbourhood households.'
  WHERE slug = 'comcrop-pilot-demo';
UPDATE farms SET name = 'Farm B', slug = 'farm-b', description = 'Local farm growing leafy greens in western Singapore.'
  WHERE slug = 'farm-b-demo';
UPDATE farms SET address = 'Singapore' WHERE address = 'Demo address (not a real location)';

UPDATE users SET full_name = 'Consumer' WHERE full_name = 'Demo Consumer';
UPDATE users SET full_name = replace(full_name, ' (Demo)', '') WHERE full_name LIKE '% (Demo)';
UPDATE buyer_profiles SET organisation_name = 'Consumer' WHERE organisation_name = 'Demo Consumer';
UPDATE buyer_profiles SET contact_name = 'Consumer' WHERE contact_name = 'Demo Consumer';
UPDATE buyer_profiles SET organisation_name = replace(organisation_name, ' (Demo)', '') WHERE organisation_name LIKE '% (Demo)';
UPDATE buyer_profiles SET contact_name = replace(contact_name, ' (Demo)', '') WHERE contact_name LIKE '% (Demo)';
UPDATE shop_listings SET title = replace(title, ' (Demo)', '') WHERE title LIKE '% (Demo)';
UPDATE shop_listings SET description = 'About 1kg of freshly harvested kale.' WHERE description = 'DEMO / PILOT DATA';
UPDATE shop_listings SET margin_override_reason = regexp_replace(margin_override_reason, '^Demo: ', '') WHERE margin_override_reason LIKE 'Demo: %';

UPDATE community_drops SET community_name = replace(community_name, ' (Demo)', '') WHERE community_name LIKE '% (Demo)';
UPDATE community_drops SET collection_point = 'Yishun community centre' WHERE collection_point = 'Demo collection point — Yishun';
UPDATE community_drops SET notes = NULL WHERE notes = 'DEMO / PILOT DATA';
UPDATE harvest_batches SET notes = NULL WHERE notes = 'DEMO / PILOT DATA';
UPDATE demand_requests SET notes = NULL WHERE notes = 'DEMO / PILOT DATA';
UPDATE batch_dispositions SET notes = NULL WHERE notes = 'DEMO / PILOT DATA';
UPDATE batch_dispositions SET recipient = 'Community food programme' WHERE recipient = 'Demo community food programme';

UPDATE orders SET cancelled_reason = 'Buyer menu change' WHERE cancelled_reason = 'Demo: buyer menu change';
UPDATE order_disputes SET description = regexp_replace(description, '^Demo: d', 'D') WHERE description LIKE 'Demo: %';
UPDATE harvest_matches SET decision_note = 'Reserved for premium buyers' WHERE decision_note = 'Demo: reserved for premium buyers';
UPDATE rescue_listings SET reason_details = 'Slightly bruised leaves, flavour unaffected' WHERE reason_details = 'Demo: slightly bruised leaves, flavour unaffected';
UPDATE buyer_relationships SET notes = regexp_replace(notes, '^DEMO: ', '') WHERE notes LIKE 'DEMO: %';
UPDATE route_selections SET assessment = '{}'::jsonb WHERE assessment::text LIKE '%DEMO / PILOT DATA%';
UPDATE match_runs SET summary = '{}'::jsonb WHERE summary::text LIKE '%DEMO / PILOT DATA%';
