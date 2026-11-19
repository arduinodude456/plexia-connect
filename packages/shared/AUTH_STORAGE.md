# Auth-Speicher: einmalige Umstellung

Connect verwendet `plexia-connect-auth-v1`, Studio `plexia-studio-auth-v1`. Die Schlüssel sind öffentliche Bezeichner, keine Secrets. Beim ersten Aufruf nach dem Update ist ein erneuter Beitritt per Code erforderlich: Die vorherige anonyme Identität wird nicht übernommen, sodass deren bestehende Teilnahme und Antworten nicht automatisch fortgesetzt werden. Danach bleibt die neue Sitzung wie bisher erhalten.

Eine automatische Übernahme des alten Supabase-Standardschlüssels erfolgt bewusst nicht: Er wurde von beiden Apps geteilt und lässt die zugehörige App oder Rolle nicht zuverlässig erkennen. Sein Inhalt wird weder gelesen noch gelöscht oder protokolliert. Das schützt ältere, noch geöffnete App-Versionen vor unbeabsichtigtem Logout; deren Sitzungen bleiben allerdings bis zu ihrer eigenen Abmeldung oder Ablauf bestehen. Sind noch alte Versionen im Einsatz, besteht dort weiterhin das bisherige Kollisionsrisiko. Bereits serverseitig beendete Sitzungen können durch diese Umstellung nicht wiederhergestellt werden.

Connect verwendet bei expliziten Abmeldungen Supabase-Scope `local`: Die aktuelle Auth-Sitzung wird beim Auth-Dienst abgemeldet, nicht alle Sitzungen dieses Kontos. Dabei werden keine Profile gelöscht. Ein Abmeldefehler kann den Beitritt verhindern.
