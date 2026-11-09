# Obrazovka v čakárni s TV programom – mini PC pri televízore (variant odporúčaný v2)

Samsung TV (Tizen) neumožní vlastnej aplikácii zobraziť inú aplikáciu (Antik TV) v okne. Preto obrazovku
kreslí **malý počítač pripojený k TV cez HDMI**; televízor je len monitor (vstup HDMI, zapína sa ovládačom ako doteraz).

```
 Samsung TV ◄── HDMI ── mini PC (Windows, Chrome) ── LAN/Wi-Fi ── server AdNa (PC sestry)
                                 └── internet ── webtv.sk (Antik TV, vaše predplatné)
```

## Čo treba
* Mini PC s Windows 11 (napr. Intel N100, 8 GB RAM, ~150 – 220 €), HDMI kábel, Microsoft Edge (súčasť Windows; alebo Google Chrome bez hlasu).
* Predplatné Antik TV s voľným miestom pre webové zariadenie (Antik uvádza max. 7 zariadení: 2 TV + 5 mobil/web).
* **Súhlas Antiku s verejným premietaním v čakárni a licencie SOZA / LITA / SLOVGRAM** (pozri hlavný súhrn).

## Postup

Najjednoduchšie: dvojklik na `1-NASTAVENIE.cmd` (kroky 3–5), potom `2-SPUSTIT-OBRAZOVKU.cmd`; záloha `3-ZALOHA-DVE-OKNA.cmd`.

1. Skopírujte priečinok `minipc` na mini PC, napr. do `C:\AdNa\minipc`.
2. Prvé spustenie (PowerShell): `powershell -ExecutionPolicy Bypass -File C:\AdNa\minipc\spustit-obrazovku.ps1` (predvolene server `https://vyvolavaci.adna.sk`; v LAN `-Server http://IP-SERVERA:8080`)
3. Jednorazovo nainštalujte rozšírenie do profilu obrazovky: spustite skript s prepínačom `-Nastavenie`
   (otvorí `chrome://extensions` v profile obrazovky), zapnite **Režim pre vývojárov** → **Načítať rozbalené** → vyberte
   priečinok `rozsirenie-tv-ramec`. Rozšírenie platí len v tomto profile, bežné prehliadanie neovplyvní.
4. V aplikácii Sestra → Nastavenia → **Obrazovka v čakárni** zadajte *Adresu TV prehrávača* `https://webtv.sk/`.
5. Na mini PC sa raz prihláste do webtv.sk myšou priamo v TV zóne; prihlásenie ostane v profile `%LOCALAPPDATA%\AdNa`.
   Od verzie 1.1 rozšírenie v tomto profile povolí prihlasovacie cookies prehrávača vo vloženom okne (bez neho stránka
   hlási „chybné údaje“, lebo prehliadač cookies vo vloženom okne zahodí). Pri aktualizácii rozšírenia: `1-NASTAVENIE.cmd`
   → pri starom rozšírení AdNa **Odstrániť** → **Načítať rozbalené** → priečinok `rozsirenie-tv-ramec` z nového balíka.
6. Plánovač úloh → Vytvoriť úlohu → Spúšťač „Pri prihlásení“, akcia: rovnaký príkaz ako v bode 2 (bez `-Nastavenie`). Zapnite automatické
   prihlásenie Windows a vypnite uspávanie obrazovky.

## Online aktualizácia
Spúšťač si pri každom spustení stiahne z GitHubu najnovšie súbory podľa `subory.txt` (spúšťač, rozšírenie, návod).
Rozšírenie sa načíta z tohto priečinka, preto nová verzia platí hneď po spustení. Priečinok preto nechajte na stálom mieste
(napr. `C:\AdNa\obrazovka`) a rozšírenie načítajte práve odtiaľ. Bez internetu sa spustí doterajšia verzia.
Vypnutie: prepínač `-BezAktualizacie`. Aplikácie Sestra a obrazovka sú webové stránky, aktualizuje ich server sám.

## Dva režimy
| Režim | Ako funguje | Kedy |
|---|---|---|
| `-Rezim ramec` (predvolený) | Jedno okno Chrome na celú obrazovku. Prehrávač je vložený v TV zóne. Rozšírenie `rozsirenie-tv-ramec` v **tomto kioskovom profile** povolí vloženie webtv.sk. Výzva s číslom sa pri vyvolaní ukáže aj cez TV obraz. | ak webtv.sk vo vloženom okne prehráva |
| `-Rezim okna` (záloha) | Stránka AdNa na celú obrazovku s čiernou TV zónou + samostatné okno prehrávača presne nad ňou. Výzva s číslom je v ľavom paneli a na dolnej lište (TV obraz nezakrýva). | len ak prehrávač vo vloženom okne nefunguje ani s rozšírením 1.1 (napr. DRM) |

## Neoverené (treba vyskúšať na mieste – nemali sme prístup k webtv.sk)
* či webtv.sk prehráva v Chrome na Windows a či niektoré kanály nevyžadujú DRM, ktoré vo vloženom okne nepôjde;
* či prihlásenie do webtv.sk vydrží (alebo ho treba občas obnoviť); oprava prihlásenia vo vloženom okne (rozšírenie 1.1)
  je overená na napodobnenine webtv.sk (`node apps/tv/test/e2e-ramec-prihlasenie.js`), nie na skutočnom webtv.sk;
* presné súradnice okna v režime `okna` (titulková lišta okna `--app` môže zabrať ~30 px).


## Hlasové hlásenie (v3.1)

Po zvukovom signáli TV povie napr. „Číslo dvadsaťpäť, ambulancia jedna“ alebo „Písmeno bé, ambulancia dva“.
Hlas poskytuje prehliadač na mini PC – preto skript predvolene spúšťa **Microsoft Edge** (`-Prehliadac edge`):

* s internetom použije prirodzený **ženský** hlas **Microsoft Viktória Online (Natural) – slovenčina** (Pali preferuje ženský hlas; mužský Lukáš len ako záloha),
* bez internetu lokálny hlas Windows **Microsoft Filip** – doinštalujte ho: Nastavenia → Čas a jazyk → Jazyk a oblasť →
  Pridať jazyk → Slovenčina (stačí „Rozpoznávanie a syntéza reči“).

Skúška: `spustit-obrazovku.ps1 -Nastavenie` otvorí aj `…/obrazovka/?hlas=test` – po 2,5 s zaznie signál a „Číslo dvadsaťpäť,
ambulancia jedna“. Ak slovenský hlas chýba, v lište TV svieti štítok **„Chýba slovenský hlas“**.
Hlas zapnete/vypnete a nastavíte rýchlosť v aplikácii Sestra → Nastavenia → Obrazovka → Hlasové hlásenie
(bez zvuku sa nehlási ani hlas). Rozšírenie `rozsirenie-tv-ramec` sa v Edge načíta rovnako cez `edge://extensions`
→ Režim pre vývojárov → Načítať rozbalené.
