select d.job_id::text || chr(31) || regexp_replace(m[1], '[\t\n\r]', ' ', 'g')
from (
  select job_id, prompt_text from decide_audit
  where job_id::text like any (array['771f42de%','9bed3bd7%','a72ec96d%','27bd816f%','3740585f%','8677476e%'])
) d, lateral regexp_matches(d.prompt_text, 'ocr="([^"]*)"', 'g') as m;
