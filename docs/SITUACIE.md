# Ošetrené situácie

| # | Situácia | Správanie systému |
|---|---|---|
| 1 | Pacient stlačí tlačidlo viackrát | Tlačidlo sa zamkne už pri dotyku (pointerdown); jedno stlačenie = jedna požiadavka s jedinečným `requestId`. Server vytvorí najviac jedno číslo na `requestId`. Overené testom (trojitý dotyk → 1 číslo). |
| 2 | Výpadok siete/servera počas registrácie | Tablet opakuje **tú istú** požiadavku (rovnaký `requestId`, 3 pokusy 1/2/4 s), potom ukáže zrozumiteľnú chybu s „Skúsiť znova“. Ak server požiadavku spracoval a stratila sa len odpoveď, opakovanie vráti **to isté číslo**. Výpadok internetu nevadí – systém beží v LAN. Android aplikácia pri nedostupnom serveri ukáže vlastnú obrazovku a pripojí sa sama. |
| 3 | Obrazovka v čakárni sa reštartuje | Po načítaní si vyžiada úplný stav (posledné vyvolanie a história); zvuk sa pri obnovení neprehrá znova. |
| 4 | Sestra omylom vyvolá nesprávne číslo | „Vrátiť medzi čakajúcich“ – číslo sa vráti na pôvodné miesto v poradí a **zmizne z obrazovky** v čakárni (zobrazí sa predchádzajúce vyvolanie). |
| 5 | Pacient nereaguje | „Zopakovať“ (znovu zvuk a zvýraznenie, počítadlo vyvolaní), potom „Neprítomný“. Ak príde neskôr, sestra ho môže znovu vyvolať alebo vrátiť medzi čakajúcich. |
| 6 | Dve sestry vyvolajú toho istého pacienta | Server pustí iba prvé vyvolanie; druhá sestra dostane hlásenie „Číslo A012 už medzičasom vyvolala iná sestra (Ambulancia č. 1).“ „Vyvolať ďalšieho“ z viacerých PC naraz vyvolá vždy rôznych pacientov. Overené testom. |
| 7 | Prehliadač zablokuje zvuk | Android TV aplikácia povoľuje zvuk bez kliknutia. V bežnom prehliadači sa zobrazí tlačidlo „Zapnúť zvuk“ (ovládateľné aj diaľkovým ovládačom / Enter) a kým zvuk nie je aktívny, upozornenie „Zvuk nie je aktívny“. |
| 8 | Počítač sestry sa obnoví alebo reštartuje | Prihlásenie je uložené na serveri (relácia 12 h, prežije aj reštart servera); po otvorení sa načíta úplný stav. Predvolená ambulancia je zapamätaná na danom PC. |
| 9 | Nový deň, v zozname ostali nevybavené čísla | Číslovanie začína od A001 (podľa Europe/Bratislava). Staré čísla sa do nového zoznamu neprenášajú, ostávajú v histórii; sestra vidí upozornenie „Z dňa … ostalo N nevybavených čísel. Do dnešného zoznamu sa neprenášajú.“ s tlačidlom „Zobraziť v histórii“. Staré číslo nemožno omylom vyvolať. |
| 10 | Tablet sa po zobrazení čísla vráti na úvodnú obrazovku | Automaticky po nastavenom čase (predvolene 15 s) alebo tlačidlom „Hotovo“; číslo je na vytlačenom lístku a v zozname sestry. Ak tlač zlyhala, tablet to pacientovi povie a sestra vidí upozornenie s tlačidlom „Znovu vytlačiť lístok“. |

Tlač:
| Stav | Pacient na tablete | Sestra |
|---|---|---|
| tlačiareň potvrdila bez chyby | „Lístok sa tlačí, vezmite si ho.“ | – |
| tlačiareň neodpovedá na stavový dotaz | neutrálny text, netvrdí sa, že sa vytlačilo | upozornenie „Tlač neoverená“ + opakovaná tlač |
| chýba papier / otvorený kryt / nedostupná | „Lístok sa nepodarilo vytlačiť. Zapamätajte si, prosím, svoje číslo. Sestra je informovaná.“ | upozornenie „Tlač zlyhala“ s dôvodom + opakovaná tlač |
