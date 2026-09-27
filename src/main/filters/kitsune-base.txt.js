'use strict';

/**
 * Список правил блокировки Kitsune.
 *
 * Формат — совместимый с Adblock Plus / EasyList подмножеством.
 * Это компактный встроенный список: реальные рекламные и трекинговые
 * сети, счётчики, аналитика, а также типовые шаблоны баннеров.
 * Его можно расширить, положив дополнительный файл рядом и запустив
 * `AdBlocker.addFiltersFromText(...)` (см. main.js, loadFilterLists).
 *
 * Строки, начинающиеся с "!", — комментарии.
 */

const KITSUNE_FILTERS = `
! ============================================================
! Kitsune Browser — базовый список блокировки рекламы и трекеров
! v1.0.0
! ============================================================

! --- Рекламные сети / биржи ---
||doubleclick.net^
||googlesyndication.com^
||googleadservices.com^
||google-analytics.com^
||googletagservices.com^
||googletagmanager.com^
||adservice.google.com^
||adservice.google.*^
||pagead2.googlesyndication.com^
||partner.googleadservices.com^
||pubads.g.doubleclick.net^
||securepubads.g.doubleclick.net^
||static.doubleclick.net^
||ad.doubleclick.net^
||stats.g.doubleclick.net^
||c.amazon-adsystem.com^
||aax.amazon-adsystem.com^
||adsystem.amazon-adsystem.com^
||ads.yahoo.com^
||advertising.com^
||adnxs.com^
||adnxs-simple.com^
||adsrvr.org^
||rubiconproject.com^
||pubmatic.com^
||openx.net^
||criteo.com^
||criteo.net^
||taboola.com^
||outbrain.com^
||zedo.com^
||undertone.com^
||smartadserver.com^
||casalemedia.com^
||33across.com^
||sharethrough.com^
||teads.tv^
||adform.net^
||adroll.com^
||bidswitch.net^
||adsafeprotected.com^
||moatads.com^
||serving-sys.com^
||sizmek.com^
||flashtalking.com^
||yieldmo.com^
||gumgum.com^
||sonobi.com^
||indexww.com^
||districtm.io^
||rtbhouse.com^
||improvedigital.com^
||1rx.io^
||tremorhub.com^
||lijit.com^
||turn.com^
||agkn.com^
||demdex.net^
||everesttech.net^
||omtrdc.net^
||2o7.net^
||propellerads.com^
||propellerads.net^
||onclickads.net^
||popads.net^
||popcash.net^
||adsterra.com^
||exoclick.com^
||juicyads.com^
||trafficjunky.com^
||adcash.com^
||clickadu.com^
||hilltopads.net^
||mgid.com^
||revcontent.com^
||adskeeper.com^
||media.net^
||contextweb.com^
||yandex.ru/ads^
||an.yandex.ru^
||ads.yandex.ru^
||avatars.mds.yandex.net/ads^
||adfox.ru^
||adfox.yandex.ru^
||top-fwz1.mail.ru^
||ads.vk.com^
||ad.mail.ru^
||r.mail.ru^
||target.my.com^
||ad.mail.ru^
||vungle.com^
||applovin.com^
||unityads.unity3d.com^
||chartboost.com^
||inmobi.com^
||mopub.com^
||startapp.com^
||tapjoy.com^
||supersonicads.com^
||adjust.com^
||appsflyer.com^

! --- Трекеры и аналитика ---
||scorecardresearch.com^
||quantserve.com^
||quantcount.com^
||hotjar.com^
||mouseflow.com^
||fullstory.com^
||clicktale.net^
||crazyegg.com^
||luckyorange.com^
||inspectlet.com^
||segment.io^
||segment.com^
||mixpanel.com^
||amplitude.com^
||heapanalytics.com^
||kissmetrics.com^
||matomo.cloud^
||statcounter.com^
||histats.com^
||newrelic.com^
||bugsnag.com^
||sentry.io^
||branch.io^
||bluekai.com^
||krxd.net^
||exelator.com^
||tapad.com^
||bidr.io^
||adsymptotic.com^
||mathtag.com^
||liadm.com^
||rlcdn.com^
||crwdcntrl.net^
||casalemedia.com^
||sitescout.com^
||simpli.fi^
||zeotap.com^
||id5-sync.com^
||thetradedesk.com^
||adentifi.com^
||teads.tv^
||3lift.com^
||bidtellect.com^
||nativo.com^
||adsnative.com^
||adyoulike.com^
||stickyadstv.com^
||tidaltv.com^
||veruta.com^
||zanox.com^
||awin1.com^
||tradedoubler.com^
||clickbank.net^
||linksynergy.com^
||impact-radius.com^
||shareasale.com^

! --- Счётчики и пиксели соцсетей ---
||facebook.com/tr^
||connect.facebook.net^
||pixel.facebook.com^
||ct.pinterest.com^
||analytics.twitter.com^
||static.ads-twitter.com^
||ads.linkedin.com^
||px.ads.linkedin.com^
||snap.licdn.com^
||analytics.tiktok.com^
||business-api.tiktok.com^
||mc.yandex.ru^
||metrika.yandex.ru^
||vk.com/rtrg^
||top.mail.ru^

! --- Типовые шаблоны баннеров и попапов ---
/ads/*
/adsbygoogle*
/adserver/*
/ad-server/*
/adframe/*
/adframe.
/ad_banner/*
/ad-banner/*
/adsense/*
/advertisement/*
/advertising/*
/bannerad/*
/banner_ads/*
/banners/ad/*
/popunder*
/popup/ads/*
/affiliate-banner*
/sponsored/*
/promo/ad/*
/interstitial/ad*
/300x250/*
/728x90/*
/160x600/*
/970x90/*
/ad_click?
/adclick?
/adview?
/adlogger/*
/adlog.php
/adserve/*
/adserving/*
/adtrack/*
/ad-track/*
/analytics.js
/ga.js
/gtag/js
/gtm.js
/counter.js
/watch?v=*&ad_type=
*ad_type=popup*
*ad_type=banner*
*banner_ad.*
*clickunder*
*load-ads.
*show_ads.
*ad_unit=*
*bannerid=*
*zoneid=*
*adzone=*
*campaign_id=*
*/advert/*
*/pubads/*
*/prebid*
*/ads.js
*/ads.min.js
*/adsbygoogle.js
*/gpt.js
*/fuckadblock*
*/adblock-detector*
*/detectadblock*
*/adblock_detect*
*ads.php?
*ad.php?
*ads.js?
*banner.php?
*banner.js
*popup.js
*promo.js
*sponsor.js

! --- Отслеживание скролла/кликов и антиадблок-скрипты ---
||adblockdetector.com^
||fuckadblock.com^
||blockadblock.com^
||detectadblock.com^
||adblocker.js^

! --- Исключения (не блокировать полезное) ---
@@||duckduckgo.com^
@@||google.com/recaptcha^
@@||gstatic.com/recaptcha^
@@||youtube.com/api/stats^
@@||cdn.jsdelivr.net^$script
@@||unpkg.com^$script
@@||cdnjs.cloudflare.com^$script

! --- Сторонние счётчики: блокируем только скрипты/картинки/фреймы ---
/1x1.gif$image
/track.gif$image
/track.png$image
/trackpixel$image
/pixel.gif$image
/conversion.gif$image
/beacon?$ping
/collect?$ping
/i.gif?$image

! --- Рекламные биржи и сети (дополнительно) ---
||adnxs.com^
||adsrvr.org^
||bidswitch.net^
||casalemedia.com^
||contextweb.com^
||criteo.com^
||criteo.net^
||demdex.net^
||dotomi.com^
||exelator.com^
||eyeota.net^
||gumgum.com^
||ib.adnxs.com^
||indexww.com^
||inmobi.com^
||ipredictive.com^
||lijit.com^
||mathtag.com^
||media.net^
||mgid.com^
||mookie1.com^
||openx.net^
||outbrain.com^
||pubmatic.com^
||quantcast.com^
||quantserve.com^
||rubiconproject.com^
||sharethrough.com^
||smartadserver.com^
||smaato.net^
||spotxchange.com^
||taboola.com^
||teads.tv^
||tremorhub.com^
||turn.com^
||undertone.com^
||yieldmo.com^
||zemanta.com^
||zqtk.net^
||adform.net^
||adition.com^
||adroll.com^
||adtech.de^
||advertising.com^
||amazon-adsystem.com^
||bidr.io^
||bluekai.com^
||brightcove.com/ads^
||bttrack.com^
||carbonads.net^
||chitika.net^
||conversantmedia.com^
||crwdcntrl.net^
||exponential.com^
||flashtalking.com^
||freewheel.tv^
||gemius.pl^
||hotjar.com^
||innity.net^
||krxd.net^
||liveadvert.com^
||loopme.me^
||mixpanel.com^
||mopub.com^
||nativeads.com^
||netmng.com^
||nexac.com^
||nuffnang.com.my^
||omnitagjs.com^
||onesignal.com^
||pardot.com^
||popads.net^
||propellerads.com^
||revsci.net^
||richaudience.com^
||rlcdn.com^
||segment.io^
||serving-sys.com^
||sitescout.com^
||sonobi.com^
||tapad.com^
||tribalfusion.com^
||tynt.com^
||vindicosuite.com^
||yieldlab.net^
||yieldmanager.com^
||zedo.com^
||zeropark.com^
||adnium.com^
||adspirit.de^
||adx1.com^
||aniview.com^
||betweendigital.com^
||bidvertiser.com^
||clickagy.com^
||cootlogix.com^
||dsp.io^
||engagebdr.com^
||eyereturn.com^
||gothamads.com^
||impact-ad.jp^
||imrworldwide.com^
||inskinmedia.com^
||kargo.com^
||media6degrees.com^
||metadsp.co.uk^
||nativo.com^
||nrelate.com^
||optimatic.com^
||owneriq.net^
||pixalate.com^
||po.st^
||pulsepoint.com^
||rhythmone.com^
||samba.tv^
||seedtag.com^
||sharethis.com^
||skimresources.com^
||sovrn.com^
||spotx.tv^
||stickyadstv.com^
||tremorvideo.com^
||tribalfusion.com^
||vidora.com^
||yieldbot.com^

! --- Шаблоны рекламных URL ---
*/adserver/*
*/adservice/*
*/advertiser/*
*/adnetwork/*
*/adframe/*
*/adunit/*
*/adzone/*
*/popunder*
*/interstitial/ad*
*/sponsored/*
*/adsense/*
*/adwords/*
*/adloader*
*/ad-provider*
*/ad_slot*
*/prebid*
*/gpt.js
*/analytics.min.js$third-party
*/tracking.js$third-party
*/tracker.js$third-party
*/telemetry.js$third-party
*/pixel.png?
*/tracking_pixel*

! --- Push-уведомления и навязчивые попапы ---
||onesignal.com^$third-party
||pushengage.com^
||izooto.com^
||webpushr.com^
||cleverpush.com^
||foxpush.net^
||pushcrew.com^
||sendpulse.com^
||subscribers.com^
||vwo.com^
||push-notification.js
*/push-notification*
*/subscribe-popup*
*/exit-intent*

! ============================================================
! Косметические правила — реклама не грузится И не показывается
! (формат uBlock Origin: selector, domain##selector, #@# — исключение)
! ============================================================

! --- Общие безопасные правила: типовые контейнеры рекламы ---
##.adsbygoogle
##.ad-banner
##.ad-container
##.ad-wrapper
##.ad-slot
##.advertisement
##.advertising-container
##.banner-ad
##.banner-ads
##.sponsored-content
##.sponsored-post
##.promoted-content
##[id^="div-gpt-ad"]
##[id^="google_ads_"]
##[data-ad-slot]
##iframe[src*="doubleclick.net"]
##iframe[src*="/adserver/"]
##iframe[src*="googlesyndication.com"]
##ins.adsbygoogle

! --- Навязчивые «липкие» баннеры и оверлеи ---
##.sticky-ad
##.sticky-banner
##.floating-ad
##.popup-ad
##.interstitial-ad
##.cookie-consent-banner
##.gdpr-banner

! --- Косметика по сайтам ---
youtube.com##.ytp-ad-module
youtube.com##.ytp-ad-overlay-container
youtube.com##.ytp-ad-progress-list
youtube.com##.video-ads
youtube.com##ytd-promoted-sparkles-web-renderer
youtube.com##ytd-promoted-video-renderer
youtube.com##ytd-display-ad-renderer
youtube.com##ytd-ad-slot-renderer
youtube.com##ytd-in-feed-ad-layout-renderer
youtube.com##ytd-banner-promo-renderer
youtube.com##ytd-statement-banner-renderer
youtube.com##ytd-companion-slot-renderer
youtube.com###player-ads
m.youtube.com##.player-ads
m.youtube.com##ytm-promoted-sparkles-web-renderer
vk.com##.ads_ads_news_wrap
vk.com##.post__ads
dzen.ru##.ads
dzen.ru##[class*="advert"]
mail.ru##[class*="banner"]
ok.ru##.ads
lenta.ru##.banner
rbc.ru##.ads
ria.ru##.banner
drive2.ru##.ads
habr.com##.tm-ads
habr.com##[class*="promo"]
pikabu.ru##.ad
pikabu.ru##[class*="promo"]
twitch.tv##.stream-display-ad__container
facebook.com##div[data-pagelet^="FeedUnit_"]:has-text(Реклама)
facebook.com##[aria-label="Спонсируемая публикация"]
twitter.com##article:has-text(Продвигается)
x.com##[data-testid="placementTracking"]
reddit.com##.promotedlink
reddit.com##shreddit-ad-post

! ============================================================
! Подмена рекламных скриптов пустышкой ($redirect) — как в uBlock
! Origin: реклама не грузится, но сайт не ломается из-за «дырки»
! в загрузке скрипта.
! ============================================================
||pagead2.googlesyndication.com/pagead/js/adsbygoogle.js$script,redirect=noopjs
||pagead2.googlesyndication.com/pagead/js/lidar.js$script,redirect=noopjs
||googletagservices.com/tag/js/gpt.js$script,redirect=noopjs
||googletagmanager.com/gtag/js$script,redirect=noopjs
||google-analytics.com/analytics.js$script,redirect=noopjs
||google-analytics.com/ga.js$script,redirect=noopjs
||static.doubleclick.net/instream/ad_status.js$script,redirect=noopjs
||securepubads.g.doubleclick.net/tag/js/gpt.js$script,redirect=noopjs
||adservice.google.com/adsid/integrator.js$script,redirect=noopjs
||cdn.jsdelivr.net/npm/adsbygoogle$script,redirect=noopjs
/adsbygoogle.js$script,redirect=noopjs
/googletagservices/tag/js/gpt.js$script,redirect=noopjs
/pagead/js/adsbygoogle.js$script,redirect=noopjs
/prebid*.js$script,redirect=noopjs
/1x1.gif$image,redirect=1x1.gif
/pixel.gif$image,redirect=1x1.gif
/track.gif$image,redirect=1x1.gif

! ============================================================
! Чистка ссылок от меток слежки ($removeparam) — только для
! переходов по адресам, чтобы не ломать запросы сайтов.
! ============================================================
$document,removeparam=fbclid
$document,removeparam=gclid
$document,removeparam=yclid
$document,removeparam=msclkid
$document,removeparam=utm_source
$document,removeparam=utm_medium
$document,removeparam=utm_campaign
$document,removeparam=utm_content
$document,removeparam=utm_term
$document,removeparam=_openstat

! ============================================================
! Всплывающие окна и «уведомления» рекламных сетей ($popup)
! ============================================================
||propellerads.com^$popup
||onclickads.net^$popup
||popads.net^$popup
||popcash.net^$popup
||adsterra.com^$popup
||clickadu.com^$popup
||hilltopads.net^$popup
||exoclick.com^$popup
||trafficjunky.com^$popup
||adcash.com^$popup
||zeropark.com^$popup
||mgid.com^$popup
||revcontent.com^$popup
||push-notification*$popup
`;

module.exports = { KITSUNE_FILTERS };
