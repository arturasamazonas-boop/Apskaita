-- Reference data (not demo data): starter chart of accounts, posting roles, VAT codes, document series.
-- The chart is a simplified starting point modelled on commonly used Lithuanian account numbering;
-- the company's accountant must review and adapt it (docs/TAX_RULES.md).

INSERT INTO accounts(code, name, type, subtype, system_role) VALUES
 ('1100','Nematerialusis turtas','asset','noncurrent',NULL),
 ('1240','Kita įranga, prietaisai ir įrenginiai','asset','noncurrent','fixed_assets'),
 ('1249','Kitos įrangos sukauptas nusidėvėjimas','asset','noncurrent',NULL),
 ('2040','Pirktos prekės, skirtos perparduoti','asset','inventory','inventory'),
 ('2070','Sumokėti avansai','asset','current','advances_paid'),
 ('2410','Pirkėjų įsiskolinimas','asset','receivable','receivable'),
 ('2441','Gautinas PVM','asset','current','vat_input'),
 ('2710','Sąskaitos bankuose','asset','cash','bank_default'),
 ('2711','Taupomoji banko sąskaita','asset','cash',NULL),
 ('2720','Kasa','asset','cash',NULL),
 ('2730','Pinigai kelyje (vidiniai pervedimai)','asset','cash','transfer_clearing'),
 ('2810','Ateinančių laikotarpių sąnaudos','asset','current','prepaid'),
 ('3010','Įstatinis kapitalas','equity','',NULL),
 ('3410','Ankstesnių metų nepaskirstytasis pelnas (nuostoliai)','equity','','retained_earnings'),
 ('3420','Ataskaitinių metų pelnas (nuostoliai)','equity','','current_result'),
 ('4430','Skolos tiekėjams','liability','payable','payable'),
 ('4480','Kitos mokėtinos sumos','liability','current',NULL),
 ('4490','Gauti išankstiniai apmokėjimai','liability','current','advances_received'),
 ('4492','Mokėtinas PVM','liability','current','vat_output'),
 ('4499','Tarpinė: neišaiškinti mokėjimai','liability','current','unidentified'),
 ('5000','Pardavimo pajamos (prekės)','revenue','','revenue_goods'),
 ('5001','Paslaugų pajamos','revenue','','revenue_services'),
 ('5002','Pristatymo paslaugų pajamos','revenue','','revenue_shipping'),
 ('5800','Kitos veiklos pajamos','revenue','',NULL),
 ('6000','Parduotų prekių savikaina','expense','cogs','cogs'),
 ('6110','Reklamos sąnaudos','expense','',NULL),
 ('6120','Transporto ir pristatymo sąnaudos','expense','',NULL),
 ('6304','Patalpų nuomos sąnaudos','expense','',NULL),
 ('6305','Komunalinių paslaugų sąnaudos','expense','',NULL),
 ('6306','Valymo ir patalpų priežiūros sąnaudos','expense','',NULL),
 ('6307','Ryšių sąnaudos','expense','',NULL),
 ('6308','Kanceliarinės prekės','expense','',NULL),
 ('6309','Programinė įranga ir IT paslaugos','expense','',NULL),
 ('6310','Apskaitos, teisinės ir konsultacinės paslaugos','expense','',NULL),
 ('6311','Reprezentacinės sąnaudos','expense','',NULL),
 ('6312','Smulkaus inventoriaus sąnaudos','expense','',NULL),
 ('6810','Banko paslaugų sąnaudos','expense','','bank_fees'),
 ('6820','Mokėjimų tarpininkų mokesčiai','expense','','processor_fees'),
 ('6899','Kitos sąnaudos','expense','',NULL);

-- VAT codes from the VMI PVM classifier (VA-49, consolidated version in force from 2026-01-01).
-- Only the codes this application supports automatically are active; others need accountant setup.
INSERT INTO tax_codes(code, isaf_code, rate, description, applies_to, effective_from, effective_to, active) VALUES
 ('PVM1','PVM1',21,'Standartinis 21 % tarifas (PVMĮ 19 str. 1 d.)','both','2009-09-01',NULL,true),
 ('PVM2','PVM2',9,'Lengvatinis 9 % tarifas (PVMĮ 19 str. 3 d.) – galiojo iki 2025-12-31','both','2009-09-01','2025-12-31',true),
 ('PVM3','PVM3',5,'Lengvatinis 5 % tarifas (PVMĮ 19 str. 4 d.)','both','2009-09-01',NULL,true),
 ('PVM58','PVM58',12,'12 % tarifas šalies teritorijoje suteiktoms paslaugoms (PVMĮ 19 str. 3 d.)','both','2026-01-01',NULL,true),
 ('PVM5','PVM5',NULL,'Neapmokestinama PVM (PVMĮ 20–33, 112 str.) – reikia buhalterio patvirtinimo','both','2009-09-01',NULL,true),
 ('PVM12','PVM12',0,'0 % – prekių eksportas (PVMĮ 41 str.) – reikia buhalterio patvirtinimo','sales','2009-09-01',NULL,true),
 ('PVM13','PVM13',0,'0 % – ES PVM mokėtojams patiektos prekės (PVMĮ 49 str.) – reikia buhalterio patvirtinimo','sales','2020-11-01',NULL,true),
 ('PVM100','PVM100',NULL,'Kiti atvejai – reikia buhalterio patvirtinimo','purchase','2016-04-01',NULL,true);

INSERT INTO document_series(code, register, doc_type, next_number, padding, description) VALUES
 ('PP','sales','invoice',1,6,'PVM sąskaitos faktūros'),
 ('KS','sales','credit_note',1,6,'Kreditinės PVM sąskaitos faktūros');
