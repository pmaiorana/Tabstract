//
//  SafariWebExtensionHandler.swift
//  Tabstract Extension
//
//  Created by Paul Maiorana on 3/17/25.
//

import SafariServices
#if os(macOS)
import FoundationModels
import AppKit
#elseif os(iOS)
import UIKit
#endif
import os.log


private actor PendingStore {
    private var work: [String: [String: Any]] = [:]
    private var results: [String: [String: Any]] = [:]

    func setWork(_ data: [String: Any], for requestId: String) {
        work[requestId] = data
    }

    func takeWork(for requestId: String) -> [String: Any]? {
        work.removeValue(forKey: requestId)
    }

    func setResult(_ data: [String: Any], for requestId: String) {
        results[requestId] = data
    }

    func takeResult(for requestId: String) -> [String: Any]? {
        results.removeValue(forKey: requestId)
    }
}

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    #if os(macOS)
    static let appGroupID = "84HBFJDM48.group.com.paulmaiorana.Tabstract"
    #else
    static let appGroupID = "group.com.paulmaiorana.Tabstract"
    #endif

    #if os(macOS)
    // MARK: - Generable Response Types for Structured Output

    @available(macOS 26.0, *)
    @Generable
    struct TitleResponse {
        @Guide(description: "A concise title (1-6 words) describing the browser tabs. Never use generic labels like 'Other', 'Misc', or 'Miscellaneous'.")
        let title: String
    }

    @available(macOS 26.0, *)
    @Generable
    struct CategorizeResponse {
        @Guide(description: "Array of categories, each grouping related tabs by specific topic. Never use generic labels like 'Other', 'Misc', 'Miscellaneous', or 'Various'.")
        let categories: [Category]
    }

    @available(macOS 26.0, *)
    @Generable
    struct Category {
        @Guide(description: "Category name (1-3 words) for a group of 3+ tabs. Each category MUST have at least 3 tabs - never create categories with only 1-2 tabs.")
        let name: String

        @Guide(description: "Array of tab indices (0-based) belonging to this category. Must contain at least 3 indices.")
        let tabIndices: [Int]
    }

    @available(macOS 26.0, *)
    @Generable
    struct ThemesResponse {
        @Guide(description: "Array of distinct themes identified in the tabs. Never use generic names like 'Other', 'Misc', 'Miscellaneous', or 'Various'.")
        let themes: [Theme]
    }

    @available(macOS 26.0, *)
    @Generable
    struct Theme {
        @Guide(description: "Theme name (1-3 words) for ONE distinct activity or topic based on actual tab content. Different purposes get different themes. Related steps for the same purpose get one theme.")
        let name: String

        @Guide(description: "Brief description of what the user is trying to accomplish with this activity based on the actual tabs.")
        let description: String
    }
    #endif

    // Store pending work and results across polls
    private let pendingStore = PendingStore()

    // MARK: - Initialization

    override init() {
        super.init()

        os_log(.info, "SafariWebExtensionHandler initialized")
    }

    #if os(macOS)
    // MARK: - Localized Prompt Generation

    /// Generate system prompt in the user's language
    @available(macOS 26.0, *)
    private func getSystemPrompt(for language: String) -> String {
        let lang = language.prefix(2).lowercased()

        switch lang {
        case "es":
            return """
            Eres un asistente útil que organiza las pestañas del navegador en categorías significativas e intuitivas con etiquetas basadas en inferir la intención y los objetivos del usuario del navegador.

            Analiza el contenido real para determinar qué está haciendo el usuario y cómo organizaría sus pestañas según lo que está tratando de lograr. Observa:
            - Nombres de dominio y títulos de página para entender el tema
            - Si las pestañas sirven para el mismo propósito o para propósitos diferentes
            - Qué actividad u objetivo conecta las pestañas relacionadas

            Crea nombres de categoría descriptivos (1-6 palabras) basados en lo que observas en las pestañas.
            Mantén las diferentes actividades separadas. Agrupa los pasos relacionados dentro de la misma actividad de manera amplia.
            Nunca uses etiquetas genéricas vagas como "Otro", "Misc", "Misceláneos" o "Varios".

            Importante: Siempre responde en español.
            """

        case "fr":
            return """
            Vous êtes un assistant utile qui organise les onglets du navigateur en catégories significatives et intuitives avec des étiquettes basées sur l'inférence de l'intention et des objectifs de l'utilisateur du navigateur.

            Analysez le contenu réel pour déterminer ce que l'utilisateur fait et comment il organiserait ses onglets en fonction de ce qu'il essaie d'accomplir. Regardez :
            - Les noms de domaine et les titres de page pour comprendre le sujet
            - Si les onglets servent le même objectif ou des objectifs différents
            - Quelle activité ou objectif relie les onglets connexes

            Créez des noms de catégorie descriptifs (1-6 mots) basés sur ce que vous observez dans les onglets.
            Gardez les différentes activités séparées. Regroupez les étapes connexes au sein de la même activité de manière large.
            N'utilisez jamais d'étiquettes génériques vagues comme "Autre", "Divers" ou "Variés".

            Important : Répondez toujours en français.
            """

        case "de":
            return """
            Sie sind ein hilfreicher Assistent, der Browser-Tabs in sinnvolle, intuitive Kategorien mit Beschriftungen organisiert, basierend auf der Ableitung der Absicht und Ziele des Browser-Benutzers.

            Analysieren Sie den tatsächlichen Inhalt, um zu bestimmen, was der Benutzer tut und wie er seine Tabs basierend auf dem organisieren würde, was er zu erreichen versucht. Schauen Sie sich an:
            - Domainnamen und Seitentitel, um das Thema zu verstehen
            - Ob Tabs demselben Zweck oder unterschiedlichen Zwecken dienen
            - Welche Aktivität oder welches Ziel verwandte Tabs verbindet

            Erstellen Sie beschreibende Kategorienamen (1-6 Wörter) basierend auf dem, was Sie in den Tabs beobachten.
            Halten Sie unterschiedliche Aktivitäten getrennt. Gruppieren Sie verwandte Schritte innerhalb derselben Aktivität umfassend.
            Verwenden Sie niemals vage generische Bezeichnungen wie "Andere", "Sonstiges" oder "Verschiedenes".

            Wichtig: Antworten Sie immer auf Deutsch.
            """

        case "it":
            return """
            Sei un assistente utile che organizza le schede del browser in categorie significative e intuitive con etichette basate sull'inferenza dell'intento e degli obiettivi dell'utente del browser.

            Analizza il contenuto effettivo per determinare cosa sta facendo l'utente e come organizzerebbe le sue schede in base a ciò che sta cercando di realizzare. Guarda:
            - Nomi di dominio e titoli di pagina per comprendere l'argomento
            - Se le schede servono allo stesso scopo o a scopi diversi
            - Quale attività o obiettivo collega le schede correlate

            Crea nomi di categoria descrittivi (1-6 parole) basati su ciò che osservi nelle schede.
            Mantieni le diverse attività separate. Raggruppa i passaggi correlati all'interno della stessa attività in modo ampio.
            Non usare mai etichette generiche vaghe come "Altro", "Varie" o "Vari".

            Importante: Rispondi sempre in italiano.
            """

        case "ja":
            return """
            あなたは、ブラウザユーザーの意図と目標を推測することに基づいて、ブラウザのタブを意味のある直感的なカテゴリとラベルに整理する便利なアシスタントです。

            実際のコンテンツを分析して、ユーザーが何をしているか、達成しようとしていることに基づいてタブをどのように整理するかを判断します。以下を確認してください：
            - トピックを理解するためのドメイン名とページタイトル
            - タブが同じ目的か異なる目的に役立つか
            - 関連するタブを結びつける活動や目標

            タブで観察したことに基づいて、説明的なカテゴリ名（1〜6語）を作成します。
            異なる活動は分けてください。同じ活動内の関連するステップは広くグループ化してください。
            「その他」、「雑多」、「その他いろいろ」などの曖昧な一般的なラベルは決して使用しないでください。

            重要：必ず日本語で応答してください。
            """

        case "ko":
            return """
            브라우저 사용자의 의도와 목표를 추론하여 브라우저 탭을 의미 있고 직관적인 카테고리와 레이블로 구성하는 유용한 도우미입니다.

            실제 콘텐츠를 분석하여 사용자가 무엇을 하고 있는지, 달성하려는 것을 기반으로 탭을 어떻게 구성할지 결정합니다. 다음을 확인하세요:
            - 주제를 이해하기 위한 도메인 이름과 페이지 제목
            - 탭이 동일한 목적을 제공하는지 다른 목적을 제공하는지
            - 관련 탭을 연결하는 활동이나 목표

            탭에서 관찰한 내용을 기반으로 설명적인 카테고리 이름(1-6단어)을 만듭니다.
            다른 활동은 별도로 유지하세요. 동일한 활동 내의 관련 단계는 광범위하게 그룹화하세요.
            "기타", "잡동사니", "기타 등등"과 같은 모호한 일반 레이블은 절대 사용하지 마세요.

            중요: 항상 한국어로 답변하세요.
            """

        case "nl":
            return """
            U bent een nuttige assistent die browsertabbladen organiseert in betekenisvolle, intuïtieve categorieën met labels op basis van het afleiden van de intentie en doelen van de browsergebruiker.

            Analyseer de feitelijke inhoud om te bepalen wat de gebruiker doet en hoe hij zijn tabbladen zou organiseren op basis van wat hij probeert te bereiken. Kijk naar:
            - Domeinnamen en paginatitels om het onderwerp te begrijpen
            - Of tabbladen hetzelfde doel of verschillende doelen dienen
            - Welke activiteit of doel gerelateerde tabbladen verbindt

            Creëer beschrijvende categorienamen (1-6 woorden) op basis van wat u in de tabbladen observeert.
            Houd verschillende activiteiten gescheiden. Groepeer gerelateerde stappen binnen dezelfde activiteit breed.
            Gebruik nooit vage generieke labels zoals "Overig", "Diversen" of "Verschillende".

            Belangrijk: Antwoord altijd in het Nederlands.
            """

        case "pt":
            return """
            Você é um assistente útil que organiza abas do navegador em categorias significativas e intuitivas com rótulos baseados em inferir a intenção e objetivos do usuário do navegador.

            Analise o conteúdo real para determinar o que o usuário está fazendo e como ele organizaria suas abas com base no que está tentando realizar. Observe:
            - Nomes de domínio e títulos de página para entender o tópico
            - Se as abas servem ao mesmo propósito ou propósitos diferentes
            - Qual atividade ou objetivo conecta abas relacionadas

            Crie nomes de categoria descritivos (1-6 palavras) com base no que você observa nas abas.
            Mantenha diferentes atividades separadas. Agrupe etapas relacionadas dentro da mesma atividade amplamente.
            Nunca use rótulos genéricos vagos como "Outro", "Diversos" ou "Vários".

            Importante: Responda sempre em português.
            """

        case "ru":
            return """
            Вы полезный помощник, который организует вкладки браузера в значимые, интуитивно понятные категории с метками на основе определения намерений и целей пользователя браузера.

            Проанализируйте фактическое содержимое, чтобы определить, что делает пользователь и как он организовал бы свои вкладки на основе того, чего он пытается достичь. Посмотрите на:
            - Доменные имена и заголовки страниц, чтобы понять тему
            - Служат ли вкладки одной и той же цели или разным целям
            - Какая деятельность или цель связывает связанные вкладки

            Создавайте описательные названия категорий (1-6 слов) на основе того, что вы наблюдаете во вкладках.
            Держите разные виды деятельности раздельно. Группируйте связанные шаги в рамках одной деятельности широко.
            Никогда не используйте расплывчатые общие ярлыки, такие как "Другое", "Разное" или "Прочее".

            Важно: Всегда отвечайте на русском языке.
            """

        case "sv":
            return """
            Du är en hjälpsam assistent som organiserar webbläsarflikar i meningsfulla, intuitiva kategorier med etiketter baserade på att dra slutsatser om webbläsaranvändarens avsikt och mål.

            Analysera det faktiska innehållet för att avgöra vad användaren gör och hur de skulle organisera sina flikar baserat på vad de försöker uppnå. Titta på:
            - Domännamn och sidtitlar för att förstå ämnet
            - Om flikar tjänar samma syfte eller olika syften
            - Vilken aktivitet eller vilket mål som förbinder relaterade flikar

            Skapa beskrivande kategorinamn (1-6 ord) baserat på vad du observerar i flikarna.
            Håll olika aktiviteter åtskilda. Gruppera relaterade steg inom samma aktivitet brett.
            Använd aldrig vaga generiska etiketter som "Övrigt", "Blandat" eller "Diverse".

            Viktigt: Svara alltid på svenska.
            """

        case "zh":
            return """
            您是一个有用的助手，根据推断浏览器用户的意图和目标，将浏览器标签页组织成有意义、直观的类别和标签。

            分析实际内容以确定用户正在做什么，以及他们将如何根据他们试图完成的事情来组织他们的标签页。查看：
            - 域名和页面标题以了解主题
            - 标签页是服务于相同目的还是不同目的
            - 什么活动或目标连接相关标签页

            根据您在标签页中观察到的内容创建描述性类别名称（1-6个词）。
            保持不同的活动分开。广泛地将相关步骤分组在同一活动中。
            永远不要使用模糊的通用标签，如"其他"、"杂项"或"各种"。

            重要：始终用中文回答。
            """

        case "ar":
            return """
            أنت مساعد مفيد ينظم علامات تبويب المتصفح في فئات ذات مغزى وبديهية مع تسميات بناءً على استنتاج نية المستخدم وأهدافه.

            قم بتحليل المحتوى الفعلي لتحديد ما يفعله المستخدم وكيف سينظم علامات التبويب الخاصة به بناءً على ما يحاول تحقيقه. انظر إلى:
            - أسماء النطاقات وعناوين الصفحات لفهم الموضوع
            - ما إذا كانت علامات التبويب تخدم نفس الغرض أو أغراضاً مختلفة
            - أي نشاط أو هدف يربط علامات التبويب ذات الصلة

            قم بإنشاء أسماء فئات وصفية (1-6 كلمات) بناءً على ما تلاحظه في علامات التبويب.
            احتفظ بالأنشطة المختلفة منفصلة. قم بتجميع الخطوات ذات الصلة ضمن نفس النشاط على نطاق واسع.
            لا تستخدم أبداً تسميات عامة غامضة مثل "أخرى" أو "متنوعة" أو "مختلف".

            مهم: أجب دائمًا باللغة العربية.
            """

        default: // English
            return """
            You are a helpful assistant that organizes browser tabs into meaningful, intuitive categories with labels based on inferring the browser user's intent and goals.

            Analyze the actual content to determine what the user is doing and how they would organize their tabs based on what they are trying to accomplish. Look at:
            - Domain names and page titles to understand the topic
            - Whether tabs serve the same purpose or different purposes
            - What activity or goal connects related tabs

            Create descriptive category names (1-6 words) based on what you observe in the tabs.
            Keep different activities separate. Group related steps within the same activity broadly.
            Never use vague generic labels like "Other", "Misc", "Miscellaneous", or "Various".

            Important: Always respond in English.
            """
        }
    }

    /// Generate title generation prompt in the user's language
    @available(macOS 26.0, *)
    private func getTitlePrompt(tabDescriptions: String, language: String) -> String {
        let lang = language.prefix(2).lowercased()

        switch lang {
        case "es":
            return """
            Crea un título de sección estilo catálogo para estas pestañas:
            \(tabDescriptions)

            REGLAS:
            - Máximo 6 palabras
            - Prefiere 1-3 palabras cuando sea posible
            - Usa palabras de categoría única para temas unificados ("Deportes", "Tecnología", "Noticias")
            - Nunca uses etiquetas genéricas como "Otro", "Misc" o "Misceláneos"
            - Ejemplos: "Noticias de Tecnología", "Deportes", "Compras y Viajes"
            """

        case "fr":
            return """
            Créez un titre de section de style catalogue pour ces onglets :
            \(tabDescriptions)

            RÈGLES :
            - Maximum 6 mots
            - Préférez 1-3 mots si possible
            - Utilisez des mots de catégorie unique pour les thèmes unifiés ("Sports", "Tech", "Actualités")
            - N'utilisez jamais d'étiquettes génériques comme "Autre", "Divers" ou "Misc"
            - Exemples : "Actualités Tech", "Sports", "Shopping et Voyage"
            """

        case "de":
            return """
            Erstellen Sie einen Katalogtitel für diese Tabs:
            \(tabDescriptions)

            REGELN:
            - Maximum 6 Wörter
            - Bevorzugen Sie 1-3 Wörter, wenn möglich
            - Verwenden Sie einzelne Kategorienwörter für einheitliche Themen ("Sport", "Tech", "Nachrichten")
            - Verwenden Sie niemals generische Bezeichnungen wie "Andere", "Sonstiges" oder "Verschiedenes"
            - Beispiele: "Tech-Nachrichten", "Sport", "Shopping und Reisen"
            """

        case "it":
            return """
            Crea un titolo di sezione in stile catalogo per queste schede:
            \(tabDescriptions)

            REGOLE:
            - Massimo 6 parole
            - Preferisci 1-3 parole quando possibile
            - Usa parole di categoria singole per temi unificati ("Sport", "Tech", "Notizie")
            - Non usare mai etichette generiche come "Altro", "Varie" o "Vari"
            - Esempi: "Notizie Tech", "Sport", "Shopping e Viaggi"
            """

        case "ja":
            return """
            これらのタブのカタログスタイルのセクションタイトルを作成してください：
            \(tabDescriptions)

            ルール：
            - 最大6語
            - 可能であれば1〜3語を優先
            - 統一されたテーマには単一のカテゴリワードを使用（「スポーツ」、「テクノロジー」、「ニュース」）
            - 「その他」、「雑多」、「その他いろいろ」などの一般的なラベルは決して使用しないでください
            - 例：「テクノロジーニュース」、「スポーツ」、「ショッピングと旅行」
            """

        case "ko":
            return """
            다음 탭에 대한 카탈로그 스타일 섹션 제목을 만드세요:
            \(tabDescriptions)

            규칙:
            - 최대 6단어
            - 가능하면 1-3단어 선호
            - 통합 테마에는 단일 카테고리 단어 사용("스포츠", "기술", "뉴스")
            - "기타", "잡동사니", "기타 등등"과 같은 일반 레이블은 절대 사용하지 마세요
            - 예: "기술 뉴스", "스포츠", "쇼핑 및 여행"
            """

        case "nl":
            return """
            Maak een catalogusstijl sectietitel voor deze tabbladen:
            \(tabDescriptions)

            REGELS:
            - Maximum 6 woorden
            - Geef de voorkeur aan 1-3 woorden indien mogelijk
            - Gebruik enkele categoriewoorden voor uniforme thema's ("Sport", "Tech", "Nieuws")
            - Gebruik nooit generieke labels zoals "Overig", "Diversen" of "Verschillende"
            - Voorbeelden: "Tech Nieuws", "Sport", "Winkelen en Reizen"
            """

        case "pt":
            return """
            Crie um título de seção em estilo de catálogo para estas abas:
            \(tabDescriptions)

            REGRAS:
            - Máximo 6 palavras
            - Prefira 1-3 palavras quando possível
            - Use palavras de categoria única para temas unificados ("Esportes", "Tech", "Notícias")
            - Nunca use rótulos genéricos como "Outro", "Diversos" ou "Vários"
            - Exemplos: "Notícias de Tech", "Esportes", "Compras e Viagens"
            """

        case "ru":
            return """
            Создайте заголовок раздела в каталожном стиле для этих вкладок:
            \(tabDescriptions)

            ПРАВИЛА:
            - Максимум 6 слов
            - Предпочтительно 1-3 слова, когда возможно
            - Используйте отдельные слова категорий для унифицированных тем («Спорт», «Технологии», «Новости»)
            - Никогда не используйте общие ярлыки, такие как «Другое», «Разное» или «Прочее»
            - Примеры: «Новости технологий», «Спорт», «Покупки и путешествия»
            """

        case "sv":
            return """
            Skapa en katalogstyld sektionstitel för dessa flikar:
            \(tabDescriptions)

            REGLER:
            - Maximum 6 ord
            - Föredra 1-3 ord när det är möjligt
            - Använd enstaka kategoriord för enhetliga teman ("Sport", "Teknik", "Nyheter")
            - Använd aldrig generiska etiketter som "Övrigt", "Blandat" eller "Diverse"
            - Exempel: "Tekniknyheter", "Sport", "Shopping och Resor"
            """

        case "zh":
            return """
            为这些标签页创建目录样式的部分标题：
            \(tabDescriptions)

            规则：
            - 最多6个词
            - 尽可能使用1-3个词
            - 对统一主题使用单一类别词（"体育"、"科技"、"新闻"）
            - 永远不要使用通用标签，如"其他"、"杂项"或"各种"
            - 示例："科技新闻"、"体育"、"购物和旅行"
            """

        case "ar":
            return """
            أنشئ عنوان قسم بأسلوب الكتالوج لهذه علامات التبويب:
            \(tabDescriptions)

            قواعد:
            - حد أقصى 6 كلمات
            - فضّل 1-3 كلمات عندما يكون ذلك ممكناً
            - استخدم كلمات فئة واحدة للموضوعات الموحدة ("رياضة"، "تقنية"، "أخبار")
            - لا تستخدم أبداً تسميات عامة مثل "أخرى" أو "متنوعة" أو "مختلف"
            - أمثلة: "أخبار تقنية"، "رياضة"، "تسوق وسفر"
            """

        default: // English
            return """
            Create a catalog-style section title for these tabs:
            \(tabDescriptions)

            RULES:
            - Maximum 6 words
            - Prefer 1-3 words when possible
            - Use single category words for unified themes ("Sports", "Tech", "News")
            - Never use generic labels like "Other", "Misc", or "Miscellaneous"
            - Examples: "Tech News", "Sports", "Shopping and Travel"
            """
        }
    }

    /// Generate categorization prompt in the user's language
    @available(macOS 26.0, *)
    private func getCategorizationPrompt(tabDescriptions: String, language: String) -> String {
        let lang = language.prefix(2).lowercased()

        switch lang {
        case "es":
            return """
            IDIOMA: Todos los nombres de categorías deben estar en español. Nunca usar inglés.

            Agrupa estas pestañas del navegador en categorías amplias y significativas. Prefiere menos grupos más grandes en lugar de muchos pequeños.

            PRINCIPIO CLAVE: Por defecto, combina las pestañas a menos que estén obviamente no relacionadas. Busca CUALQUIER conexión.

            Pestañas (dispersas - escanea TODAS antes de agrupar):
            \(tabDescriptions)

            REGLAS DE AGRUPACIÓN:
            1. Cada categoría necesita 3+ pestañas mínimo (nunca crear grupos de 1-2 pestañas)
            2. Combina pestañas con temas compartidos, dominios o conexiones sueltas
            3. Cada pestaña debe ir en exactamente una categoría
            4. Nombres de categoría: 1-3 palabras describiendo el tema más amplio
            5. Nunca usar "Otro", "Misc", "Misceláneos" o "Varios"

            COMBINA estos (no dividir):
            - Sitios de noticias (tecnología + general) → "Noticias"
            - Compras (diferentes productos) → "Compras"
            - Redes sociales (diferentes plataformas) → "Redes Sociales"
            - Herramientas de desarrollo (docs + GitHub + Stack Overflow) → "Desarrollo"
            - Entretenimiento (YouTube + Spotify + streaming) → "Entretenimiento"
            - Herramientas de trabajo (Slack + email + calendario) → "Trabajo"

            SOLO DIVIDIR cuando verdaderamente incompatible:
            - Banca + Juegos → 2 categorías (completamente diferentes)
            - Médico + Muebles → 2 categorías (sin conexión)
            - Búsqueda de empleo + Recetas → 2 categorías (no relacionadas)

            INCORRECTO - NO HACER ESTO:
            - 8 pestañas divididas en 6 categorías (demasiado granular)
            - Categoría con índices de pestaña [0, 1] (solo 2 pestañas - demasiado pequeña)
            - Categoría con índice de pestaña [5] (solo 1 pestaña - nunca hacer esto)
            - Dividir sitios de noticias similares en categorías separadas (combinarlos)
            - Dividir sitios de compras por tipo de producto (mantener juntos como "Compras")
            - Crear micro-categorías para temas sutilmente diferentes (fusionar en tema más amplio)

            PROCESO:
            1. Escanea TODAS las pestañas para encontrar 2-3 temas PRINCIPALES (ser muy conservador)
            2. Agrupa cada pestaña bajo el tema principal más cercano (interpretar ampliamente)
            3. Verifica que cada grupo tenga 3+ pestañas (si no, fusionar con el tema más cercano)

            Conteos objetivo (apunta al extremo BAJO):
            - 6–10 pestañas: 2 categorías
            - 11–16 pestañas: 2-3 categorías
            - 17–25 pestañas: 3-4 categorías
            - 25+ pestañas: 4-5 categorías

            Mejor tener 2 categorías bien pobladas que 5 pequeñas.
            NOTA: Solo recibirás 6+ pestañas (conjuntos más pequeños obtienen un título simple en su lugar).

            IMPORTANTE: Todos los nombres de categorías DEBEN estar en español.
            """

        case "fr":
            return """
            LANGUE : Tous les noms de catégories doivent être en français. Ne jamais utiliser l'anglais.

            Regroupez ces onglets du navigateur en catégories larges et significatives. Préférez moins de groupes plus grands plutôt que beaucoup de petits.

            PRINCIPE CLÉ : Par défaut, combinez les onglets sauf s'ils sont manifestement sans rapport. Cherchez N'IMPORTE QUELLE connexion.

            Onglets (dispersés - scannez TOUS avant de regrouper) :
            \(tabDescriptions)

            RÈGLES DE REGROUPEMENT :
            1. Chaque catégorie nécessite au moins 3+ onglets (ne jamais créer de groupes de 1-2 onglets)
            2. Combinez les onglets avec des thèmes partagés, des domaines ou des connexions lâches
            3. Chaque onglet doit aller dans exactement une catégorie
            4. Noms de catégorie : 1-3 mots décrivant le thème plus large
            5. Ne jamais utiliser "Autre", "Divers" ou "Variés"

            COMBINEZ ceux-ci (ne pas séparer) :
            - Sites d'actualités (tech + général) → "Actualités"
            - Achats (différents produits) → "Achats"
            - Réseaux sociaux (différentes plateformes) → "Réseaux Sociaux"
            - Outils de développement (docs + GitHub + Stack Overflow) → "Développement"
            - Divertissement (YouTube + Spotify + streaming) → "Divertissement"
            - Outils de travail (Slack + email + calendrier) → "Travail"

            SÉPAREZ UNIQUEMENT lorsque vraiment incompatible :
            - Banque + Jeux → 2 catégories (complètement différents)
            - Médical + Meubles → 2 catégories (aucun lien)
            - Recherche d'emploi + Recettes → 2 catégories (non liés)

            INCORRECT - NE PAS FAIRE CECI :
            - 8 onglets divisés en 6 catégories (trop granulaire)
            - Catégorie avec indices d'onglets [0, 1] (seulement 2 onglets - trop petit)
            - Catégorie avec indice d'onglet [5] (seulement 1 onglet - ne jamais faire ça)
            - Séparer des sites d'actualités similaires en catégories séparées (les combiner)
            - Séparer les sites d'achats par type de produit (garder ensemble comme "Achats")
            - Créer des micro-catégories pour des sujets subtilement différents (fusionner en thème plus large)

            PROCESSUS :
            1. Scannez TOUS les onglets pour trouver 2-3 thèmes MAJEURS (être très conservateur)
            2. Regroupez chaque onglet sous le thème majeur le plus proche (interpréter largement)
            3. Vérifiez que chaque groupe a 3+ onglets (sinon, fusionner avec le thème le plus proche)

            Comptages cibles (visez l'extrémité BASSE) :
            - 6–10 onglets : 2 catégories
            - 11–16 onglets : 2-3 catégories
            - 17–25 onglets : 3-4 catégories
            - 25+ onglets : 4-5 catégories

            Mieux vaut avoir 2 catégories bien peuplées que 5 petites.
            NOTE : Vous ne recevrez que 6+ onglets (les plus petits ensembles obtiennent un titre simple à la place).

            IMPORTANT : Tous les noms de catégories DOIVENT être en français.
            """

        case "de":
            return """
            SPRACHE: Alle Kategorienamen müssen auf Deutsch sein. Niemals Englisch verwenden.

            Gruppieren Sie diese Browser-Tabs in umfassende, bedeutungsvolle Kategorien. Bevorzugen Sie weniger, größere Gruppen gegenüber vielen kleinen.

            SCHLÜSSELPRINZIP: Standardmäßig Tabs kombinieren, es sei denn, sie sind offensichtlich nicht verwandt. Suchen Sie nach JEDER Verbindung.

            Tabs (verstreut - ALLE vor dem Gruppieren scannen):
            \(tabDescriptions)

            GRUPPIERUNGSREGELN:
            1. Jede Kategorie benötigt mindestens 3+ Tabs (niemals Gruppen mit 1-2 Tabs erstellen)
            2. Kombinieren Sie Tabs mit gemeinsamen Themen, Domains oder losen Verbindungen
            3. Jeder Tab muss in genau eine Kategorie gehen
            4. Kategorienamen: 1-3 Wörter, die das breitere Thema beschreiben
            5. Niemals "Andere", "Sonstiges" oder "Verschiedenes" verwenden

            KOMBINIEREN Sie diese (nicht trennen):
            - Nachrichtenseiten (Tech + Allgemein) → "Nachrichten"
            - Einkaufen (verschiedene Produkte) → "Einkaufen"
            - Soziale Medien (verschiedene Plattformen) → "Soziale Medien"
            - Entwicklungstools (Docs + GitHub + Stack Overflow) → "Entwicklung"
            - Unterhaltung (YouTube + Spotify + Streaming) → "Unterhaltung"
            - Arbeitstools (Slack + E-Mail + Kalender) → "Arbeit"

            NUR TRENNEN, wenn wirklich inkompatibel:
            - Banking + Spiele → 2 Kategorien (völlig unterschiedlich)
            - Medizin + Möbel → 2 Kategorien (keine Verbindung)
            - Jobsuche + Rezepte → 2 Kategorien (nicht verwandt)

            FALSCH - NICHT MACHEN:
            - 8 Tabs in 6 Kategorien aufgeteilt (zu granular)
            - Kategorie mit Tab-Indizen [0, 1] (nur 2 Tabs - zu klein)
            - Kategorie mit Tab-Index [5] (nur 1 Tab - niemals tun)
            - Ähnliche Nachrichtenseiten in separate Kategorien aufteilen (zusammenführen)
            - Einkaufen-Seiten nach Produkttyp aufteilen (als "Einkaufen" zusammenhalten)
            - Mikro-Kategorien für subtil unterschiedliche Themen erstellen (zu breiterem Thema fusionieren)

            PROZESS:
            1. ALLE Tabs scannen, um 2-3 HAUPTTHEMEN zu finden (sehr konservativ sein)
            2. Jeden Tab unter dem nächsten Hauptthema gruppieren (breit interpretieren)
            3. Überprüfen, dass jede Gruppe 3+ Tabs hat (falls nicht, mit nächstem Thema zusammenführen)

            Zielzahlen (streben Sie das NIEDRIGE Ende an):
            - 6–10 Tabs: 2 Kategorien
            - 11–16 Tabs: 2-3 Kategorien
            - 17–25 Tabs: 3-4 Kategorien
            - 25+ Tabs: 4-5 Kategorien

            Besser 2 gut gefüllte Kategorien als 5 winzige.
            HINWEIS: Sie erhalten nur 6+ Tabs (kleinere Sets bekommen stattdessen einen einfachen Titel).

            WICHTIG: Alle Kategorienamen MÜSSEN auf Deutsch sein.
            """

        case "it":
            return """
            LINGUA: Tutti i nomi delle categorie devono essere in italiano. Non usare mai l'inglese.

            Raggruppa queste schede del browser in categorie ampie e significative. Preferisci meno gruppi più grandi rispetto a molti piccoli.

            PRINCIPIO CHIAVE: Di default, combina le schede a meno che non siano ovviamente non correlate. Cerca QUALSIASI connessione.

            Schede (sparse - scansiona TUTTE prima di raggruppare):
            \(tabDescriptions)

            REGOLE DI RAGGRUPPAMENTO:
            1. Ogni categoria necessita di 3+ schede minimo (mai creare gruppi di 1-2 schede)
            2. Combina schede con temi condivisi, domini o connessioni vaghe
            3. Ogni scheda deve andare in esattamente una categoria
            4. Nomi di categoria: 1-3 parole che descrivono il tema più ampio
            5. Mai usare "Altro", "Varie" o "Vari"

            COMBINA questi (non separare):
            - Siti di notizie (tech + generale) → "Notizie"
            - Acquisti (prodotti diversi) → "Acquisti"
            - Social Media (piattaforme diverse) → "Social Media"
            - Strumenti di sviluppo (docs + GitHub + Stack Overflow) → "Sviluppo"
            - Intrattenimento (YouTube + Spotify + streaming) → "Intrattenimento"
            - Strumenti di lavoro (Slack + email + calendario) → "Lavoro"

            SEPARA SOLO quando veramente incompatibile:
            - Banking + Giochi → 2 categorie (completamente diversi)
            - Medico + Mobili → 2 categorie (nessuna connessione)
            - Ricerca lavoro + Ricette → 2 categorie (non correlati)

            SBAGLIATO - NON FARE QUESTO:
            - 8 schede divise in 6 categorie (troppo granulare)
            - Categoria con indici schede [0, 1] (solo 2 schede - troppo piccola)
            - Categoria con indice scheda [5] (solo 1 scheda - mai fare questo)
            - Dividere siti di notizie simili in categorie separate (combinarli)
            - Dividere siti di acquisti per tipo di prodotto (tenere insieme come "Acquisti")
            - Creare micro-categorie per argomenti sottilmente diversi (fondere in tema più ampio)

            PROCESSO:
            1. Scansiona TUTTE le schede per trovare 2-3 temi PRINCIPALI (essere molto conservativi)
            2. Raggruppa ogni scheda sotto il tema principale più vicino (interpretare ampiamente)
            3. Verifica che ogni gruppo abbia 3+ schede (se no, fondere con tema più vicino)

            Conteggi target (puntare all'estremità BASSA):
            - 6–10 schede: 2 categorie
            - 11–16 schede: 2-3 categorie
            - 17–25 schede: 3-4 categorie
            - 25+ schede: 4-5 categorie

            Meglio avere 2 categorie ben popolate che 5 piccole.
            NOTA: Riceverai solo 6+ schede (set più piccoli ottengono un titolo semplice invece).

            IMPORTANTE: Tutti i nomi delle categorie DEVONO essere in italiano.
            """

        case "ja":
            return """
            言語：すべてのカテゴリ名は日本語でなければなりません。英語は決して使用しないでください。

            これらのブラウザタブを広く意味のあるカテゴリにグループ化してください。多くの小さなグループではなく、少ない大きなグループを優先してください。

            重要な原則：明らかに関連がない場合を除き、デフォルトでタブを組み合わせてください。任意のつながりを探してください。

            タブ（散在 - グループ化する前にすべてをスキャン）：
            \(tabDescriptions)

            グループ化ルール：
            1. 各カテゴリには最低3つ以上のタブが必要（1〜2タブのグループは決して作成しない）
            2. 共有テーマ、ドメイン、またはゆるいつながりを持つタブを組み合わせる
            3. 各タブは正確に1つのカテゴリに属する必要があります
            4. カテゴリ名：より広いテーマを説明する1〜3語
            5. 「その他」、「雑多」、「その他いろいろ」などの曖昧なラベルは決して使用しないでください

            これらを組み合わせる（分割しない）：
            - ニュースサイト（テクノロジー＋一般）→「ニュース」
            - ショッピング（異なる製品）→「ショッピング」
            - ソーシャルメディア（異なるプラットフォーム）→「ソーシャルメディア」
            - 開発ツール（ドキュメント + GitHub + Stack Overflow）→「開発」
            - エンターテインメント（YouTube + Spotify + ストリーミング）→「エンターテインメント」
            - 仕事ツール（Slack +メール+カレンダー）→「仕事」

            本当に互換性がない場合のみ分割：
            - 銀行＋ゲーム → 2カテゴリ（完全に異なる）
            - 医療＋家具 → 2カテゴリ（つながりなし）
            - 求職＋レシピ → 2カテゴリ（関連なし）

            間違い - これをしないでください：
            - 8タブを6カテゴリに分割（細かすぎる）
            - タブインデックス[0, 1]のカテゴリ（2タブのみ - 小さすぎる）
            - タブインデックス[5]のカテゴリ（1タブのみ - 決してこれをしない）
            - 類似のニュースサイトを別々のカテゴリに分割（組み合わせる）
            - ショッピングサイトを製品タイプで分割（「ショッピング」として一緒に保つ）
            - 微妙に異なるトピックのマイクロカテゴリを作成（より広いテーマに統合）

            プロセス：
            1. すべてのタブをスキャンして2〜3の主要なテーマを見つける（非常に保守的に）
            2. 各タブを最も近い主要なテーマの下にグループ化（広く解釈）
            3. 各グループに3つ以上のタブがあることを確認（そうでない場合、最も近いテーマと統合）

            目標カウント（低い方を目指す）：
            - 6〜10タブ：2カテゴリ
            - 11〜16タブ：2〜3カテゴリ
            - 17〜25タブ：3〜4カテゴリ
            - 25タブ以上：4〜5カテゴリ

            5つの小さなカテゴリよりも、2つのよく配置されたカテゴリの方が良いです。
            注：6つ以上のタブのみを受け取ります（小さなセットは代わりに単純なタイトルを取得します）。

            重要：すべてのカテゴリ名は日本語でなければなりません。
            """

        case "ko":
            return """
            언어: 모든 카테고리 이름은 한국어여야 합니다. 절대 영어를 사용하지 마세요.

            이러한 브라우저 탭을 광범위하고 의미 있는 카테고리로 그룹화하세요. 많은 작은 그룹보다 적은 큰 그룹을 선호하세요.

            핵심 원칙: 명백히 관련이 없는 경우를 제외하고 기본적으로 탭을 결합하세요. 모든 연결을 찾으세요.

            탭 (분산 - 그룹화하기 전에 모두 스캔):
            \(tabDescriptions)

            그룹화 규칙:
            1. 각 카테고리에는 최소 3개 이상의 탭이 필요 (1-2개 탭 그룹은 절대 만들지 않음)
            2. 공유 테마, 도메인 또는 느슨한 연결이 있는 탭 결합
            3. 각 탭은 정확히 하나의 카테고리에 속해야 함
            4. 카테고리 이름: 더 넓은 테마를 설명하는 1-3단어
            5. "기타", "잡동사니", "기타 등등"과 같은 모호한 레이블은 절대 사용하지 마세요

            이것들을 결합 (분리하지 않음):
            - 뉴스 사이트 (기술 + 일반) → "뉴스"
            - 쇼핑 (다른 제품) → "쇼핑"
            - 소셜 미디어 (다른 플랫폼) → "소셜 미디어"
            - 개발 도구 (문서 + GitHub + Stack Overflow) → "개발"
            - 엔터테인먼트 (YouTube + Spotify + 스트리밍) → "엔터테인먼트"
            - 작업 도구 (Slack + 이메일 + 캘린더) → "업무"

            진정으로 호환되지 않을 때만 분리:
            - 은행 + 게임 → 2 카테고리 (완전히 다름)
            - 의료 + 가구 → 2 카테고리 (연결 없음)
            - 구직 + 레시피 → 2 카테고리 (관련 없음)

            잘못된 - 이렇게 하지 마세요:
            - 8개 탭을 6개 카테고리로 분할 (너무 세분화)
            - 탭 인덱스 [0, 1]인 카테고리 (2개 탭만 - 너무 작음)
            - 탭 인덱스 [5]인 카테고리 (1개 탭만 - 절대 이렇게 하지 마세요)
            - 유사한 뉴스 사이트를 별도 카테고리로 분할 (결합)
            - 쇼핑 사이트를 제품 유형별로 분할 ("쇼핑"으로 함께 유지)
            - 미묘하게 다른 주제에 대한 마이크로 카테고리 생성 (더 넓은 테마로 병합)

            프로세스:
            1. 모든 탭을 스캔하여 2-3개의 주요 테마 찾기 (매우 보수적으로)
            2. 각 탭을 가장 가까운 주요 테마 아래에 그룹화 (광범위하게 해석)
            3. 각 그룹에 3개 이상의 탭이 있는지 확인 (그렇지 않으면 가장 가까운 테마와 병합)

            목표 개수 (낮은 쪽을 목표로):
            - 6–10 탭: 2 카테고리
            - 11–16 탭: 2-3 카테고리
            - 17–25 탭: 3-4 카테고리
            - 25+ 탭: 4-5 카테고리

            5개의 작은 카테고리보다 2개의 잘 채워진 카테고리가 낫습니다.
            참고: 6개 이상의 탭만 받습니다 (더 작은 세트는 대신 간단한 제목을 받습니다).

            중요: 모든 카테고리 이름은 한국어여야 합니다.
            """

        case "nl":
            return """
            TAAL: Alle categorienamen moeten in het Nederlands zijn. Gebruik nooit Engels.

            Groepeer deze browsertabbladen in brede, betekenisvolle categorieën. Geef de voorkeur aan minder, grotere groepen boven veel kleine.

            SLEUTELPRINCIPE: Standaard tabbladen combineren tenzij ze duidelijk ongerelateerd zijn. Zoek naar ELKE verbinding.

            Tabbladen (verspreid - scan ALLE voordat u groepeert):
            \(tabDescriptions)

            GROEPERINGSREGELS:
            1. Elke categorie heeft minimaal 3+ tabbladen nodig (nooit groepen van 1-2 tabbladen maken)
            2. Combineer tabbladen met gedeelde thema's, domeinen of losse verbindingen
            3. Elk tabblad moet in precies één categorie gaan
            4. Categorienamen: 1-3 woorden die het bredere thema beschrijven
            5. Gebruik nooit vage generieke labels zoals "Overig", "Diversen" of "Verschillende"

            COMBINEER deze (niet splitsen):
            - Nieuwssites (tech + algemeen) → "Nieuws"
            - Winkelen (verschillende producten) → "Winkelen"
            - Sociale media (verschillende platforms) → "Sociale Media"
            - Ontwikkeltools (docs + GitHub + Stack Overflow) → "Ontwikkeling"
            - Entertainment (YouTube + Spotify + streaming) → "Entertainment"
            - Werktools (Slack + e-mail + agenda) → "Werk"

            ALLEEN SPLITSEN wanneer echt incompatibel:
            - Bankieren + Gaming → 2 categorieën (volledig verschillend)
            - Medisch + Meubels → 2 categorieën (geen verbinding)
            - Vacatures + Recepten → 2 categorieën (niet gerelateerd)

            ONJUIST - NIET DOEN:
            - 8 tabbladen verdeeld over 6 categorieën (te granulairiteit)
            - Categorie met tabbladindexen [0, 1] (slechts 2 tabbladen - te klein)
            - Categorie met tabbladindex [5] (slechts 1 tabblad - nooit doen)
            - Vergelijkbare nieuwssites in aparte categorieën splitsen (combineren)
            - Winkelen-sites per producttype splitsen (samen houden als "Winkelen")
            - Micro-categorieën maken voor subtiel verschillende onderwerpen (samenvoegen tot breder thema)

            PROCES:
            1. Scan ALLE tabbladen om 2-3 GROTE thema's te vinden (zeer conservatief zijn)
            2. Groepeer elk tabblad onder het dichtstbijzijnde grote thema (breed interpreteren)
            3. Controleer of elke groep 3+ tabbladen heeft (zo niet, samenvoegen met dichtstbijzijnde thema)

            Doeltellingen (streef naar de LAGE kant):
            - 6–10 tabbladen: 2 categorieën
            - 11–16 tabbladen: 2-3 categorieën
            - 17–25 tabbladen: 3-4 categorieën
            - 25+ tabbladen: 4-5 categorieën

            Beter 2 goed gevulde categorieën dan 5 kleine.
            OPMERKING: U ontvangt alleen 6+ tabbladen (kleinere sets krijgen in plaats daarvan een eenvoudige titel).

            BELANGRIJK: Alle categorienamen MOETEN in het Nederlands zijn.
            """

        case "pt":
            return """
            IDIOMA: Todos os nomes de categorias devem estar em português. Nunca usar inglês.

            Agrupe estas abas do navegador em categorias amplas e significativas. Prefira menos grupos maiores em vez de muitos pequenos.

            PRINCÍPIO CHAVE: Por padrão, combine as abas a menos que sejam obviamente não relacionadas. Procure QUALQUER conexão.

            Abas (dispersas - escaneie TODAS antes de agrupar):
            \(tabDescriptions)

            REGRAS DE AGRUPAMENTO:
            1. Cada categoria precisa de 3+ abas no mínimo (nunca criar grupos de 1-2 abas)
            2. Combine abas com temas compartilhados, domínios ou conexões soltas
            3. Cada aba deve ir em exatamente uma categoria
            4. Nomes de categoria: 1-3 palavras descrevendo o tema mais amplo
            5. Nunca use rótulos genéricos vagos como "Outro", "Diversos" ou "Vários"

            COMBINE estes (não divida):
            - Sites de notícias (tech + geral) → "Notícias"
            - Compras (produtos diferentes) → "Compras"
            - Redes sociais (plataformas diferentes) → "Redes Sociais"
            - Ferramentas de desenvolvimento (docs + GitHub + Stack Overflow) → "Desenvolvimento"
            - Entretenimento (YouTube + Spotify + streaming) → "Entretenimento"
            - Ferramentas de trabalho (Slack + email + calendário) → "Trabalho"

            APENAS DIVIDA quando verdadeiramente incompatível:
            - Bancário + Jogos → 2 categorias (completamente diferentes)
            - Médico + Móveis → 2 categorias (sem conexão)
            - Procura de emprego + Receitas → 2 categorias (não relacionadas)

            ERRADO - NÃO FAÇA ISSO:
            - 8 abas divididas em 6 categorias (muito granular)
            - Categoria com índices de aba [0, 1] (apenas 2 abas - muito pequena)
            - Categoria com índice de aba [5] (apenas 1 aba - nunca faça isso)
            - Dividir sites de notícias similares em categorias separadas (combiná-los)
            - Dividir sites de compras por tipo de produto (manter juntos como "Compras")
            - Criar micro-categorias para tópicos sutilmente diferentes (fundir em tema mais amplo)

            PROCESSO:
            1. Escaneie TODAS as abas para encontrar 2-3 temas PRINCIPAIS (ser muito conservador)
            2. Agrupe cada aba sob o tema principal mais próximo (interpretar amplamente)
            3. Verifique se cada grupo tem 3+ abas (se não, fundir com tema mais próximo)

            Contagens alvo (almeje o extremo BAIXO):
            - 6–10 abas: 2 categorias
            - 11–16 abas: 2-3 categorias
            - 17–25 abas: 3-4 categorias
            - 25+ abas: 4-5 categorias

            Melhor ter 2 categorias bem povoadas do que 5 pequenas.
            NOTA: Você receberá apenas 6+ abas (conjuntos menores obtêm um título simples em vez disso).

            IMPORTANTE: Todos os nomes de categorias DEVEM estar em português.
            """

        case "ru":
            return """
            ЯЗЫК: Все названия категорий должны быть на русском языке. Никогда не используйте английский.

            Сгруппируйте эти вкладки браузера в широкие, значимые категории. Предпочитайте меньше больших групп вместо многих маленьких.

            КЛЮЧЕВОЙ ПРИНЦИП: По умолчанию объединяйте вкладки, если они не являются явно не связанными. Ищите ЛЮБУЮ связь.

            Вкладки (разбросаны - просканируйте ВСЕ перед группировкой):
            \(tabDescriptions)

            ПРАВИЛА ГРУППИРОВКИ:
            1. Каждой категории нужно минимум 3+ вкладки (никогда не создавайте группы из 1-2 вкладок)
            2. Объединяйте вкладки с общими темами, доменами или свободными связями
            3. Каждая вкладка должна попасть ровно в одну категорию
            4. Названия категорий: 1-3 слова, описывающие более широкую тему
            5. Никогда не используйте расплывчатые общие ярлыки, такие как "Другое", "Разное" или "Прочее"

            ОБЪЕДИНЯЙТЕ эти (не разделяйте):
            - Новостные сайты (технологии + общие) → "Новости"
            - Покупки (разные продукты) → "Покупки"
            - Соцсети (разные платформы) → "Соцсети"
            - Инструменты разработки (документация + GitHub + Stack Overflow) → "Разработка"
            - Развлечения (YouTube + Spotify + стриминг) → "Развлечения"
            - Рабочие инструменты (Slack + почта + календарь) → "Работа"

            РАЗДЕЛЯЙТЕ ТОЛЬКО когда действительно несовместимо:
            - Банковское дело + Игры → 2 категории (совершенно разные)
            - Медицина + Мебель → 2 категории (нет связи)
            - Поиск работы + Рецепты → 2 категории (не связаны)

            НЕПРАВИЛЬНО - НЕ ДЕЛАЙТЕ ЭТО:
            - 8 вкладок разделены на 6 категорий (слишком детально)
            - Категория с индексами вкладок [0, 1] (только 2 вкладки - слишком мало)
            - Категория с индексом вкладки [5] (только 1 вкладка - никогда не делайте этого)
            - Разделение похожих новостных сайтов на отдельные категории (объединить их)
            - Разделение сайтов покупок по типу продукта (держать вместе как "Покупки")
            - Создание микрокатегорий для тонко различающихся тем (объединить в более широкую тему)

            ПРОЦЕСС:
            1. Просканируйте ВСЕ вкладки, чтобы найти 2-3 ОСНОВНЫЕ темы (быть очень консервативным)
            2. Сгруппируйте каждую вкладку под ближайшей основной темой (интерпретировать широко)
            3. Проверьте, что в каждой группе есть 3+ вкладки (если нет, объединить с ближайшей темой)

            Целевые подсчеты (стремитесь к НИЖНЕЙ границе):
            - 6–10 вкладок: 2 категории
            - 11–16 вкладок: 2-3 категории
            - 17–25 вкладок: 3-4 категории
            - 25+ вкладок: 4-5 категорий

            Лучше иметь 2 хорошо заполненные категории, чем 5 маленьких.
            ПРИМЕЧАНИЕ: Вы получите только 6+ вкладок (меньшие наборы вместо этого получают простой заголовок).

            ВАЖНО: Все названия категорий ДОЛЖНЫ быть на русском языке.
            """

        case "sv":
            return """
            SPRÅK: Alla kategorinamn måste vara på svenska. Använd aldrig engelska.

            Gruppera dessa webbläsarflikar i breda, meningsfulla kategorier. Föredra färre, större grupper framför många små.

            NYCKELPRINCIP: Som standard, kombinera flikar om de inte är uppenbart orelaterade. Sök efter NÅGON koppling.

            Flikar (utspridda - skanna ALLA innan gruppering):
            \(tabDescriptions)

            GRUPPERINGSREGLER:
            1. Varje kategori behöver minst 3+ flikar (skapa aldrig grupper med 1-2 flikar)
            2. Kombinera flikar med delade teman, domäner eller lösa kopplingar
            3. Varje flik måste gå i exakt en kategori
            4. Kategorinamn: 1-3 ord som beskriver det bredare temat
            5. Använd aldrig vaga generiska etiketter som "Övrigt", "Blandat" eller "Diverse"

            KOMBINERA dessa (dela inte):
            - Nyhetssajter (teknik + allmänt) → "Nyheter"
            - Shopping (olika produkter) → "Shopping"
            - Sociala medier (olika plattformar) → "Sociala medier"
            - Utvecklingsverktyg (docs + GitHub + Stack Overflow) → "Utveckling"
            - Underhållning (YouTube + Spotify + streaming) → "Underhållning"
            - Arbetsverktyg (Slack + e-post + kalender) → "Arbete"

            DELA ENDAST när verkligen inkompatibelt:
            - Bank + Spel → 2 kategorier (helt olika)
            - Medicin + Möbler → 2 kategorier (ingen koppling)
            - Jobbsökning + Recept → 2 kategorier (orelaterade)

            FEL - GÖR INTE DETTA:
            - 8 flikar uppdelade i 6 kategorier (för granulerat)
            - Kategori med flikindex [0, 1] (bara 2 flikar - för liten)
            - Kategori med flikindex [5] (bara 1 flik - gör aldrig detta)
            - Dela upp liknande nyhetssajter i separata kategorier (kombinera dem)
            - Dela upp shopping-sajter efter produkttyp (håll ihop som "Shopping")
            - Skapa mikrokategorier för subtilt olika ämnen (slå samman till bredare tema)

            PROCESS:
            1. Skanna ALLA flikar för att hitta 2-3 STORA teman (var mycket konservativ)
            2. Gruppera varje flik under närmaste stora tema (tolka brett)
            3. Verifiera att varje grupp har 3+ flikar (om inte, slå samman med närmaste tema)

            Målantal (sikta på den LÅGA änden):
            - 6–10 flikar: 2 kategorier
            - 11–16 flikar: 2-3 kategorier
            - 17–25 flikar: 3-4 kategorier
            - 25+ flikar: 4-5 kategorier

            Bättre att ha 2 välbefolkade kategorier än 5 små.
            OBS: Du får bara 6+ flikar (mindre uppsättningar får en enkel titel istället).

            VIKTIGT: Alla kategorinamn MÅSTE vara på svenska.
            """

        case "zh":
            return """
            语言：所有类别名称必须使用中文。绝不使用英语。

            将这些浏览器标签页分组为广泛且有意义的类别。优先选择更少的大组，而不是许多小组。

            关键原则：默认情况下合并标签页，除非它们明显不相关。寻找任何连接。

            标签页（分散 - 在分组之前扫描所有）：
            \(tabDescriptions)

            分组规则：
            1. 每个类别至少需要3个以上的标签页（绝不创建1-2个标签页的组）
            2. 合并具有共享主题、域或松散连接的标签页
            3. 每个标签页必须恰好属于一个类别
            4. 类别名称：描述更广泛主题的1-3个词
            5. 永远不要使用模糊的通用标签，如"其他"、"杂项"或"各种"

            合并这些（不分割）：
            - 新闻网站（科技+一般）→"新闻"
            - 购物（不同产品）→"购物"
            - 社交媒体（不同平台）→"社交媒体"
            - 开发工具（文档+ GitHub + Stack Overflow）→"开发"
            - 娱乐（YouTube + Spotify +流媒体）→"娱乐"
            - 工作工具（Slack +电子邮件+日历）→"工作"

            仅在真正不兼容时分割：
            - 银行+游戏→2个类别（完全不同）
            - 医疗+家具→2个类别（无连接）
            - 求职+食谱→2个类别（不相关）

            错误 - 不要这样做：
            - 将8个标签页分成6个类别（太细化）
            - 标签页索引为[0, 1]的类别（只有2个标签页 - 太小）
            - 标签页索引为[5]的类别（只有1个标签页 - 绝不这样做）
            - 将类似的新闻网站分成单独的类别（合并它们）
            - 按产品类型分割购物网站（作为"购物"保持在一起）
            - 为微妙不同的主题创建微类别（合并为更广泛的主题）

            过程：
            1. 扫描所有标签页以找到2-3个主要主题（非常保守）
            2. 将每个标签页分组在最接近的主要主题下（广泛解释）
            3. 验证每个组有3个以上的标签页（如果没有，与最接近的主题合并）

            目标计数（瞄准低端）：
            - 6–10个标签页：2个类别
            - 11–16个标签页：2-3个类别
            - 17–25个标签页：3-4个类别
            - 25个以上标签页：4-5个类别

            最好有2个充分填充的类别，而不是5个小类别。
            注意：您只会收到6个以上的标签页（较小的集合会得到简单的标题）。

            重要：所有类别名称必须使用中文。
            """

        case "ar":
            return """
            اللغة: يجب أن تكون جميع أسماء الفئات باللغة العربية. لا تستخدم الإنجليزية أبدًا.

            قم بتجميع علامات تبويب المتصفح هذه في فئات واسعة وذات مغزى. فضّل مجموعات أقل وأكبر بدلاً من العديد من المجموعات الصغيرة.

            المبدأ الأساسي: افتراضياً، ادمج علامات التبويب ما لم تكن غير مرتبطة بشكل واضح. ابحث عن أي اتصال.

            علامات التبويب (متفرقة - امسح الكل قبل التجميع):
            \(tabDescriptions)

            قواعد التجميع:
            1. تحتاج كل فئة إلى 3+ علامات تبويب كحد أدنى (لا تنشئ مجموعات من 1-2 علامات تبويب أبداً)
            2. ادمج علامات التبويب ذات الموضوعات المشتركة أو المجالات أو الاتصالات الفضفاضة
            3. يجب أن تذهب كل علامة تبويب في فئة واحدة بالضبط
            4. أسماء الفئات: 1-3 كلمات تصف الموضوع الأوسع
            5. لا تستخدم أبداً تسميات عامة غامضة مثل "أخرى" أو "متنوعة" أو "مختلف"

            ادمج هذه (لا تقسّم):
            - مواقع الأخبار (تقنية + عامة) → "أخبار"
            - تسوق (منتجات مختلفة) → "تسوق"
            - وسائل التواصل (منصات مختلفة) → "وسائل التواصل"
            - أدوات التطوير (مستندات + GitHub + Stack Overflow) → "تطوير"
            - ترفيه (YouTube + Spotify + بث) → "ترفيه"
            - أدوات العمل (Slack + بريد إلكتروني + تقويم) → "عمل"

            قسّم فقط عندما يكون غير متوافق حقاً:
            - مصرفية + ألعاب → فئتان (مختلفان تماماً)
            - طبي + أثاث → فئتان (لا يوجد اتصال)
            - البحث عن عمل + وصفات → فئتان (غير مرتبطة)

            خطأ - لا تفعل هذا:
            - تقسيم 8 علامات تبويب إلى 6 فئات (دقيق جداً)
            - فئة بفهرس علامات تبويب [0، 1] (علامتا تبويب فقط - صغيرة جداً)
            - فئة بفهرس علامة تبويب [5] (علامة تبويب واحدة فقط - لا تفعل هذا أبداً)
            - تقسيم مواقع الأخبار المماثلة إلى فئات منفصلة (ادمجها)
            - تقسيم مواقع التسوق حسب نوع المنتج (احتفظ بها معاً كـ"تسوق")
            - إنشاء فئات صغيرة لموضوعات مختلفة بشكل طفيف (ادمج في موضوع أوسع)

            العملية:
            1. امسح كل علامات التبويب للعثور على 2-3 موضوعات رئيسية (كن متحفظاً جداً)
            2. قم بتجميع كل علامة تبويب تحت أقرب موضوع رئيسي (فسّر على نطاق واسع)
            3. تحقق من أن كل مجموعة بها 3+ علامات تبويب (إذا لم يكن كذلك، ادمج مع أقرب موضوع)

            العدّ المستهدف (اهدف إلى الطرف المنخفض):
            - 6–10 علامات تبويب: فئتان
            - 11–16 علامة تبويب: 2-3 فئات
            - 17–25 علامة تبويب: 3-4 فئات
            - 25+ علامة تبويب: 4-5 فئات

            من الأفضل أن يكون لديك فئتان مملوءتان جيداً بدلاً من 5 فئات صغيرة.
            ملاحظة: ستحصل فقط على 6+ علامات تبويب (المجموعات الأصغر تحصل على عنوان بسيط بدلاً من ذلك).

            مهم: يجب أن تكون جميع أسماء الفئات باللغة العربية.
            """

        default: // English
            return """
            LANGUAGE: All category names must be in English.

            Group these browser tabs into broad, meaningful categories. Prefer fewer, larger groups over many small ones.

            KEY PRINCIPLE: Default to combining tabs unless they're obviously unrelated. Look for ANY connection.

            Tabs (scattered - scan ALL before grouping):
            \(tabDescriptions)

            GROUPING RULES:
            1. Each category needs 3+ tabs minimum (never create 1-2 tab groups)
            2. Combine tabs with shared themes, domains, or loose connections
            3. Every tab must go in exactly one category
            4. Category names: 1-3 words describing the broader theme
            5. Never use "Other", "Misc", "Miscellaneous", or "Various"

            COMBINE these (don't split):
            - News sites (tech + general) → "News"
            - Shopping (different products) → "Shopping"
            - Social media (different platforms) → "Social Media"
            - Dev tools (docs + GitHub + Stack Overflow) → "Development"
            - Entertainment (YouTube + Spotify + streaming) → "Entertainment"
            - Work tools (Slack + email + calendar) → "Work"

            ONLY SPLIT when truly incompatible:
            - Banking + Gaming → 2 categories (completely different)
            - Medical + Furniture → 2 categories (no connection)
            - Job hunting + Recipes → 2 categories (unrelated)

            WRONG - DON'T DO THIS:
            - 8 tabs split into 6 categories (too granular)
            - Category with tab indices [0, 1] (only 2 tabs - too small)
            - Category with tab index [5] (only 1 tab - never do this)
            - Splitting similar news sites into separate categories (combine them)
            - Splitting shopping sites by product type (keep together as "Shopping")
            - Creating micro-categories for subtly different topics (merge into broader theme)

            PROCESS:
            1. Scan ALL tabs to find 2-3 MAJOR themes (be very conservative)
            2. Group every tab under the closest major theme (interpret broadly)
            3. Verify each group has 3+ tabs (if not, merge with closest theme)

            Target counts (aim for the LOW end):
            - 6–10 tabs: 2 categories
            - 11–16 tabs: 2-3 categories
            - 17–25 tabs: 3-4 categories
            - 25+ tabs: 4-5 categories

            Better to have 2 well-populated categories than 5 tiny ones.
            NOTE: You will only receive 6+ tabs (smaller sets get a simple title instead).

            IMPORTANT: All category names MUST be in English.
            """
        }
    }

    /// Generate theme extraction prompt in the user's language
    @available(macOS 26.0, *)
    private func getThemeExtractionPrompt(tabDescriptions: String, language: String) -> String {
        let lang = language.prefix(2).lowercased()

        // For brevity, I'll create a condensed multilingual version
        // The structure is the same across all languages
        let templates: [String: (title: String, rules: String, examples: String, guidance: String)] = [
            "es": (
                "Identifica 2–5 temas distintos examinando los dominios reales de las pestañas, títulos y descripciones.",
                """
                REGLAS:
                1. Mira el dominio, título y descripción de cada pestaña: ¿de qué se trata? ¿qué está tratando de lograr el usuario?
                2. Propósitos diferentes = temas diferentes (ser liberal con la separación)
                3. Mismo propósito = un tema (combinar pasos relacionados)
                4. Nombres de temas: 1-3 palabras describiendo lo que observas
                5. Nunca usar "Otro", "Misc", "Misceláneos", "Varios"
                """,
                """
                Ejemplos de separación de temas:
                - Sitios de recetas + Compras de muebles → 2 temas (propósitos diferentes)
                - Banca + Sitios de juegos → 2 temas (no relacionados)
                - Bolsas de trabajo + Suministros para mascotas → 2 temas (actividades diferentes)

                Ejemplos de combinación de temas:
                - Múltiples sitios de recetas → 1 tema (misma actividad)
                - Múltiples tiendas de muebles → 1 tema (comprando lo mismo)
                """,
                """
                Aplicar a pestañas REALES arriba:
                - ¿Qué propósitos distintos aparecen en estas pestañas?
                - ¿Qué pestañas trabajan hacia el mismo objetivo vs diferentes objetivos?
                - Describe lo que el usuario está tratando de hacer con cada tema

                Conteos esperados:
                - 1–5 pestañas: 1–2 temas
                - 6–15 pestañas: 2–4 temas
                - 15+ pestañas: 3–6 temas

                NO asignes pestañas a temas todavía, solo identifica los temas.
                """
            ),
            "fr": (
                "Identifiez 2–5 thèmes distincts en examinant les domaines réels des onglets, les titres et les descriptions.",
                """
                RÈGLES :
                1. Regardez le domaine, le titre et la description de chaque onglet - de quoi s'agit-il? que cherche à accomplir l'utilisateur?
                2. Objectifs différents = thèmes différents (être libéral avec la séparation)
                3. Même objectif = un thème (combiner les étapes connexes)
                4. Noms de thèmes : 1-3 mots décrivant ce que vous observez
                5. Ne jamais utiliser "Autre", "Divers", "Misc", "Variés"
                """,
                """
                Exemples de séparation de thèmes :
                - Sites de recettes + Achats de meubles → 2 thèmes (objectifs différents)
                - Banque + Sites de jeux → 2 thèmes (non liés)
                - Offres d'emploi + Fournitures pour animaux → 2 thèmes (activités différentes)

                Exemples de combinaison de thèmes :
                - Plusieurs sites de recettes → 1 thème (même activité)
                - Plusieurs magasins de meubles → 1 thème (achat de la même chose)
                """,
                """
                Appliquer aux onglets RÉELS ci-dessus :
                - Quels objectifs distincts apparaissent dans ces onglets?
                - Quels onglets travaillent vers le même but vs différents buts?
                - Décrivez ce que l'utilisateur essaie de faire avec chaque thème

                Comptages attendus :
                - 1–5 onglets : 1–2 thèmes
                - 6–15 onglets : 2–4 thèmes
                - 15+ onglets : 3–6 thèmes

                Ne PAS assigner les onglets aux thèmes encore, identifiez juste les thèmes.
                """
            ),
            "de": (
                "Identifizieren Sie 2–5 unterschiedliche Themen durch Untersuchung der tatsächlichen Tab-Domains, Titel und Beschreibungen.",
                """
                REGELN:
                1. Schauen Sie sich Domain, Titel und Beschreibung jedes Tabs an - worum geht es? was versucht der Benutzer zu erreichen?
                2. Verschiedene Zwecke = verschiedene Themen (großzügig mit Trennung sein)
                3. Gleicher Zweck = ein Thema (verwandte Schritte kombinieren)
                4. Themennamen: 1-3 Wörter, die beschreiben, was Sie beobachten
                5. Niemals "Andere", "Sonstiges", "Verschiedenes" verwenden
                """,
                """
                Beispiele für Thementrennung:
                - Rezept-Sites + Möbelkauf → 2 Themen (verschiedene Zwecke)
                - Banking + Gaming-Sites → 2 Themen (nicht verwandt)
                - Jobbörsen + Haustierzubehör → 2 Themen (verschiedene Aktivitäten)

                Beispiele für Themenkombination:
                - Mehrere Rezept-Sites → 1 Thema (gleiche Aktivität)
                - Mehrere Möbelgeschäfte → 1 Thema (Kauf der gleichen Sache)
                """,
                """
                Auf TATSÄCHLICHE Tabs oben anwenden:
                - Welche unterschiedlichen Zwecke erscheinen in diesen Tabs?
                - Welche Tabs arbeiten auf dasselbe Ziel vs verschiedene Ziele hin?
                - Beschreiben Sie, was der Benutzer mit jedem Thema zu tun versucht

                Erwartete Zahlen:
                - 1–5 Tabs: 1–2 Themen
                - 6–15 Tabs: 2–4 Themen
                - 15+ Tabs: 3–6 Themen

                Weisen Sie Tabs noch NICHT Themen zu, identifizieren Sie nur die Themen.
                """
            )
        ]

        // For other languages, use English template with localized keywords
        let template = templates[lang] ?? (
            title: "Identify 2–5 distinct themes by examining the actual tab domains, titles, and descriptions.",
            rules: """
            RULES:
            1. Look at each tab's domain, title, and description - what is it about? what is the user trying to accomplish?
            2. Different purposes = different themes (be liberal with separation)
            3. Same purpose = one theme (combine related steps)
            4. Theme names: 1-3 words describing what you observe
            5. Never use "Other", "Misc", "Miscellaneous", "Various"
            """,
            examples: """
            Theme Separation Examples:
            - Recipe sites + Furniture shopping → 2 themes (different purposes)
            - Banking + Gaming sites → 2 themes (unrelated)
            - Job boards + Pet supplies → 2 themes (different activities)

            Theme Combination Examples:
            - Multiple recipe sites → 1 theme (same activity)
            - Multiple furniture stores → 1 theme (shopping for same thing)
            """,
            guidance: """
            Apply to ACTUAL tabs above:
            - What distinct purposes appear in these tabs?
            - Which tabs work toward the same goal vs different goals?
            - Describe what the user is trying to do with each theme

            Expected counts:
            - 1–5 tabs: 1–2 themes
            - 6–15 tabs: 2–4 themes
            - 15+ tabs: 3–6 themes

            Do NOT assign tabs to themes yet, just identify the themes.
            """
        )

        return """
        \(template.title)

        \(template.rules)

        Tabs:
        \(tabDescriptions)

        \(template.examples)

        \(template.guidance)
        """
    }

    /// Generate theme assignment prompt in the user's language
    @available(macOS 26.0, *)
    private func getThemeAssignmentPrompt(themesList: String, tabDescriptions: String, language: String) -> String {
        let lang = language.prefix(2).lowercased()

        let instructions: [String: String] = [
            "es": "Asigna cada pestaña a exactamente uno de los temas proporcionados. Trata los indicios proporcionados (por ejemplo, estado 401/403, palabras clave de login/portal/admin) solo como prioridades suaves y evita mezclar pestañas claramente relacionadas con el trabajo con temas personales cuando sea apropiado. Para conjuntos pequeños (≤6 pestañas), prefiere asignaciones más amplias sobre micro-categorías (evita dividir subtipos de productos).",
            "fr": "Attribuez chaque onglet à exactement un des thèmes fournis. Traitez les indices fournis (par ex., statut 401/403, mots-clés login/portal/admin) uniquement comme des priorités souples et évitez de mélanger des onglets clairement liés au travail avec des thèmes personnels lorsque cela est approprié. Pour les petits ensembles (≤6 onglets), préférez des attributions plus larges aux micro-catégories (évitez de diviser les sous-types de produits).",
            "de": "Weisen Sie jeden Tab genau einem der bereitgestellten Themen zu. Behandeln Sie bereitgestellte Hinweise (z.B. Status 401/403, login/portal/admin-Schlüsselwörter) nur als weiche Prioritäten und vermeiden Sie es, eindeutig arbeitsbezogene Tabs mit persönlichen Themen zu mischen, wenn es angemessen ist. Für kleine Sets (≤6 Tabs) bevorzugen Sie breitere Zuweisungen gegenüber Mikro-Kategorien (vermeiden Sie das Aufteilen von Produktuntertypen).",
            "it": "Assegna ogni scheda a esattamente uno dei temi forniti. Tratta gli indizi forniti (ad es., stato 401/403, parole chiave login/portal/admin) solo come priorità morbide ed evita di mescolare schede chiaramente legate al lavoro con temi personali quando appropriato. Per set piccoli (≤6 schede), preferisci assegnazioni più ampie rispetto alle micro-categorie (evita di dividere i sottotipi di prodotto).",
            "ja": "提供されたテーマのいずれか1つに各タブを正確に割り当ててください。提供されたヒント（例：ステータス401/403、login/portal/adminキーワード）はソフトな優先順位としてのみ扱い、適切な場合は明らかに仕事関連のタブを個人的なテーマと混在させないでください。小さなセット（≤6タブ）の場合、マイクロカテゴリよりも広い割り当てを優先してください（製品サブタイプを分割しない）。",
            "ko": "제공된 테마 중 정확히 하나에 각 탭을 할당하세요. 제공된 힌트(예: 상태 401/403, login/portal/admin 키워드)는 소프트 우선순위로만 취급하고 적절한 경우 명백히 작업 관련 탭을 개인 테마와 혼합하지 마세요. 작은 세트(≤6개 탭)의 경우 마이크로 카테고리보다 더 넓은 할당을 선호하세요(제품 하위 유형 분할 방지).",
            "nl": "Wijs elk tabblad toe aan precies één van de opgegeven thema's. Behandel opgegeven hints (bijv. status 401/403, login/portal/admin trefwoorden) alleen als zachte prioriteiten en vermijd het mengen van duidelijk werkgerelateerde tabbladen met persoonlijke thema's wanneer dat gepast is. Voor kleine sets (≤6 tabbladen), geef de voorkeur aan bredere toewijzingen boven micro-categorieën (vermijd het splitsen van productsubtypes).",
            "pt": "Atribua cada aba a exatamente um dos temas fornecidos. Trate as dicas fornecidas (por exemplo, status 401/403, palavras-chave login/portal/admin) apenas como prioridades suaves e evite misturar abas claramente relacionadas ao trabalho com temas pessoais quando apropriado. Para conjuntos pequenos (≤6 abas), prefira atribuições mais amplas a micro-categorias (evite dividir subtipos de produtos).",
            "ru": "Назначьте каждую вкладку точно одной из предоставленных тем. Рассматривайте предоставленные подсказки (например, статус 401/403, ключевые слова login/portal/admin) только как мягкие приоритеты и избегайте смешивания явно связанных с работой вкладок с личными темами, когда это уместно. Для небольших наборов (≤6 вкладок) предпочитайте более широкие назначения микрокатегориям (избегайте разделения подтипов продуктов).",
            "sv": "Tilldela varje flik till exakt ett av de tillhandahållna temana. Behandla tillhandahållna tips (t.ex. status 401/403, login/portal/admin-nyckelord) endast som mjuka prioriteringar och undvik att blanda tydligt arbetsrelaterade flikar med personliga teman när det är lämpligt. För små uppsättningar (≤6 flikar), föredra bredare tilldelningar framför mikrokategorier (undvik att dela produktundertyper).",
            "zh": "将每个标签页分配给提供的主题之一。将提供的提示（例如，状态401/403、login/portal/admin关键字）仅作为软优先级处理，并在适当时避免将明显与工作相关的标签页与个人主题混合。对于小集合（≤6个标签页），优先选择更广泛的分配而不是微类别（避免分割产品子类型）。",
            "ar": "قم بتعيين كل علامة تبويب لواحد بالضبط من المواضيع المقدمة. عامل التلميحات المقدمة (مثل الحالة 401/403، كلمات login/portal/admin) كأولويات ناعمة فقط وتجنب خلط علامات التبويب المتعلقة بالعمل بشكل واضح مع المواضيع الشخصية عند الاقتضاء. بالنسبة للمجموعات الصغيرة (≤6 علامات تبويب)، فضّل التعيينات الأوسع على الفئات الدقيقة (تجنب تقسيم الأنواع الفرعية للمنتجات)."
        ]

        let rules: [String: String] = [
            "es": """
            Reglas:
            - Usa SOLO los temas proporcionados; no inventes nuevos.
            - Si una pestaña no encaja claramente en ningún tema, déjala sin asignar (omitir de todas las categorías).
            - Mantén los grupos coherentes; no mezcles temas no relacionados.
            - Los nombres de categoría DEBEN coincidir exactamente con los nombres de tema proporcionados.
            """,
            "fr": """
            Règles :
            - Utilisez UNIQUEMENT les thèmes fournis; n'en inventez pas de nouveaux.
            - Si un onglet ne correspond clairement à aucun thème, laissez-le non attribué (omettez-le de toutes les catégories).
            - Gardez les groupes cohérents; ne mélangez pas de sujets non liés.
            - Les noms de catégorie DOIVENT correspondre exactement aux noms de thème fournis.
            """,
            "de": """
            Regeln:
            - Verwenden Sie NUR die bereitgestellten Themen; erfinden Sie keine neuen.
            - Wenn ein Tab nicht eindeutig zu einem Thema passt, lassen Sie ihn nicht zugewiesen (aus allen Kategorien weglassen).
            - Halten Sie Gruppen kohärent; mischen Sie keine nicht verwandten Themen.
            - Kategorienamen MÜSSEN genau mit den bereitgestellten Themennamen übereinstimmen.
            """
        ]

        let instruction = instructions[lang] ?? "Assign each tab to exactly one of the provided themes. Treat provided hints (e.g., status 401/403, login/portal/admin keywords) only as soft priors and avoid mixing clearly work-related tabs with personal themes when appropriate. For small sets (≤6 tabs), prefer broader assignments over micro-categories (avoid splitting product subtypes)."

        let rule = rules[lang] ?? """
        Rules:
        - Use ONLY the provided themes; do not invent new ones.
        - If a tab does not clearly fit any theme, leave it unassigned (omit from all categories).
        - Keep groups coherent; do not mix unrelated topics.
        - Category names MUST match the provided theme names exactly.
        """

        return """
        \(instruction)

        Themes:
        \(themesList)

        Tabs:
        \(tabDescriptions)

        \(rule)
        """
    }
    #endif // os(macOS) — AI prompt/method definitions

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let message: Any?
        if #available(iOS 15.0, macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }

        // Handle the message asynchronously
        Task {
            let responseData = await handleMessage(message: message)

            let response = NSExtensionItem()
            if #available(iOS 15.0, macOS 11.0, *) {
                response.userInfo = [ SFExtensionMessageKey: responseData ]
            } else {
                response.userInfo = [ "message": responseData ]
            }

            context.completeRequest(returningItems: [ response ], completionHandler: nil)
        }
    }

    // MARK: - Message Handling

    private func handleMessage(message: Any?) async -> [String: Any] {
        guard let messageDict = message as? [String: Any],
              let action = messageDict["action"] as? String else {
            return ["error": "Invalid message format"]
        }

        switch action {
        case "ping":
            #if os(macOS)
            return await handlePing()
            #else
            return ["status": "unavailable", "available": false, "reason": "AI not available on iOS"]
            #endif
        #if os(macOS)
        case "generateTitle":
            return await handleGenerateTitle(data: messageDict)
        case "categorizeTabs":
            return await handleCategorizeTabs(data: messageDict)
        case "pollResult":
            return await handlePollResult(data: messageDict)
        case "extractThemes":
            return await handleExtractThemes(data: messageDict)
        case "assignTabsToThemes":
            return await handleAssignTabsToThemes(data: messageDict)
        case "checkAvailability":
            return await handleCheckAvailability()
        #else
        case "generateTitle", "categorizeTabs", "pollResult", "extractThemes", "assignTabsToThemes", "checkAvailability":
            return ["error": "Not available on iOS"]
        #endif
        case "debugLog":
            return handleDebugLog(data: messageDict)
        case "debugSnapshot":
            return handleDebugSnapshot(data: messageDict)
        case "checkElementInspectorRequest":
            return handleCheckElementInspectorRequest(data: messageDict)
        case "elementInspectorResult":
            return handleElementInspectorResult(data: messageDict)
        case "createBackup":
            return handleCreateBackup(data: messageDict)
        case "listBackups":
            return handleListBackups()
        case "readBackup":
            return handleReadBackup(data: messageDict)
        case "deleteBackup":
            return handleDeleteBackup(data: messageDict)
        case "showBackupInFinder":
            return handleShowBackupInFinder(data: messageDict)
        // MARK: - iCloud Sync
        case "syncEnable", "syncDisable", "syncStatus", "syncPush", "syncFullPush", "syncPull":
            guard #available(macOS 12.0, iOS 16.0, *) else {
                return ["success": false, "error": "iCloud Sync requires macOS 12.0 / iOS 16.0 or later"]
            }
            switch action {
            case "syncEnable": return await handleSyncEnable()
            case "syncDisable": return await handleSyncDisable()
            case "syncStatus": return await handleSyncStatus()
            case "syncPush", "syncFullPush": return await handleSyncPush(data: messageDict)
            case "syncPull": return await handleSyncPull()
            default: return ["success": false, "error": "Unknown sync action"]
            }
        default:
            return ["error": "Unknown action: \(action)"]
        }
    }

    // MARK: - Debug File Writing

    /// Returns the debug directory URL inside the App Group container, creating it if needed.
    private func debugDirectoryURL() -> URL? {
        guard let containerURL = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: SafariWebExtensionHandler.appGroupID
        ) else {
            os_log(.error, "debugDirectoryURL: Failed to access App Group container")
            return nil
        }
        let debugDir = containerURL.appendingPathComponent("debug", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: debugDir, withIntermediateDirectories: true)
        } catch {
            os_log(.error, "debugDirectoryURL: Failed to create debug directory: %@", error.localizedDescription)
            return nil
        }
        return debugDir
    }

    // MARK: - Backup File Writing

    /// Returns the backups directory URL inside the App Group container, creating it if needed.
    private func backupsDirectoryURL() -> URL? {
        guard let containerURL = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: SafariWebExtensionHandler.appGroupID
        ) else {
            os_log(.error, "backupsDirectoryURL: Failed to access App Group container")
            return nil
        }
        let backupsDir = containerURL.appendingPathComponent("backups", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: backupsDir, withIntermediateDirectories: true)
        } catch {
            os_log(.error, "backupsDirectoryURL: Failed to create backups directory: %@", error.localizedDescription)
            return nil
        }
        return backupsDir
    }

    /// Creates a backup file from the provided JSON payload.
    private func handleCreateBackup(data: [String: Any]) -> [String: Any] {
        guard let backupsDir = backupsDirectoryURL() else {
            return ["success": false, "error": "Cannot access backups directory"]
        }

        guard let backup = data["backup"] as? [String: Any] else {
            return ["success": false, "error": "Missing backup payload"]
        }

        // Generate filename from timestamp
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime]
        let timestamp = iso.string(from: Date())
            .replacingOccurrences(of: ":", with: "-")
            .replacingOccurrences(of: "+", with: "-")
        let filename = "backup-\(timestamp).json"
        let fileURL = backupsDir.appendingPathComponent(filename)

        do {
            let jsonData = try JSONSerialization.data(withJSONObject: backup, options: [.prettyPrinted, .sortedKeys])
            try jsonData.write(to: fileURL, options: .atomic)
        } catch {
            os_log(.error, "handleCreateBackup: Failed to write backup: %@", error.localizedDescription)
            return ["success": false, "error": "Failed to write backup file"]
        }

        // Enforce retention and rebuild index
        enforceRetentionPolicy()
        rebuildBackupsIndex()

        return ["success": true, "filename": filename]
    }

    /// Lists all backups by reading the index file.
    private func handleListBackups() -> [String: Any] {
        guard let backupsDir = backupsDirectoryURL() else {
            return ["success": false, "error": "Cannot access backups directory"]
        }

        let indexURL = backupsDir.appendingPathComponent("backups-index.json")

        // If index doesn't exist, rebuild it
        if !FileManager.default.fileExists(atPath: indexURL.path) {
            rebuildBackupsIndex()
        }

        // Read the index
        guard let indexData = try? Data(contentsOf: indexURL),
              let index = try? JSONSerialization.jsonObject(with: indexData) as? [[String: Any]] else {
            return ["success": true, "backups": []]
        }

        return ["success": true, "backups": index]
    }

    /// Reads a specific backup file and returns its contents.
    private func handleReadBackup(data: [String: Any]) -> [String: Any] {
        guard let backupsDir = backupsDirectoryURL() else {
            return ["success": false, "error": "Cannot access backups directory"]
        }

        guard let filename = data["filename"] as? String else {
            return ["success": false, "error": "Missing filename"]
        }

        // Validate filename to prevent path traversal
        guard filename.hasPrefix("backup-"),
              filename.hasSuffix(".json"),
              !filename.contains(".."),
              !filename.contains("/") else {
            return ["success": false, "error": "Invalid filename"]
        }

        let fileURL = backupsDir.appendingPathComponent(filename)
        guard let fileData = try? Data(contentsOf: fileURL),
              let backup = try? JSONSerialization.jsonObject(with: fileData) as? [String: Any] else {
            return ["success": false, "error": "Failed to read backup file"]
        }

        return ["success": true, "backup": backup]
    }

    /// Deletes a specific backup file.
    private func handleDeleteBackup(data: [String: Any]) -> [String: Any] {
        guard let backupsDir = backupsDirectoryURL() else {
            return ["success": false, "error": "Cannot access backups directory"]
        }

        guard let filename = data["filename"] as? String else {
            return ["success": false, "error": "Missing filename"]
        }

        // Validate filename
        guard filename.hasPrefix("backup-"),
              filename.hasSuffix(".json"),
              !filename.contains(".."),
              !filename.contains("/") else {
            return ["success": false, "error": "Invalid filename"]
        }

        let fileURL = backupsDir.appendingPathComponent(filename)
        do {
            try FileManager.default.removeItem(at: fileURL)
        } catch {
            os_log(.error, "handleDeleteBackup: Failed to delete backup: %@", error.localizedDescription)
            return ["success": false, "error": "Failed to delete backup"]
        }

        rebuildBackupsIndex()
        return ["success": true]
    }

    /// Reveals a backup file in Finder.
    private func handleShowBackupInFinder(data: [String: Any]) -> [String: Any] {
        guard let backupsDir = backupsDirectoryURL() else {
            return ["success": false, "error": "Cannot access backups directory"]
        }

        guard let filename = data["filename"] as? String else {
            return ["success": false, "error": "Missing filename"]
        }

        // Validate filename
        guard filename.hasPrefix("backup-"),
              filename.hasSuffix(".json"),
              !filename.contains(".."),
              !filename.contains("/") else {
            return ["success": false, "error": "Invalid filename"]
        }

        let fileURL = backupsDir.appendingPathComponent(filename)

        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            return ["success": false, "error": "Backup file not found"]
        }

        #if os(macOS)
        NSWorkspace.shared.activateFileViewerSelecting([fileURL])
        return ["success": true]
        #else
        return ["success": false, "error": "Not available on iOS"]
        #endif
    }

    /// Enforces tiered retention policy on backup files.
    /// - Manual/labeled backups: never auto-deleted
    /// - < 24h: keep all
    /// - 1-7 days: keep most recent per calendar day
    /// - 7-30 days: keep most recent per calendar week
    /// - > 30 days: delete
    private func enforceRetentionPolicy() {
        guard let backupsDir = backupsDirectoryURL() else { return }

        let fm = FileManager.default
        guard let files = try? fm.contentsOfDirectory(at: backupsDir, includingPropertiesForKeys: nil) else { return }

        let backupFiles = files.filter { $0.lastPathComponent.hasPrefix("backup-") && $0.lastPathComponent.hasSuffix(".json") }

        // Parse metadata from each backup
        struct BackupMeta {
            let url: URL
            let timestamp: Date
            let trigger: String
            let label: String?
        }

        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let isoBasic = ISO8601DateFormatter()
        isoBasic.formatOptions = [.withInternetDateTime]

        var metas: [BackupMeta] = []
        for fileURL in backupFiles {
            guard let data = try? Data(contentsOf: fileURL),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let tsString = json["timestamp"] as? String else { continue }

            let date = iso.date(from: tsString) ?? isoBasic.date(from: tsString) ?? Date.distantPast
            let trigger = json["trigger"] as? String ?? "auto"
            let label = json["label"] as? String

            metas.append(BackupMeta(url: fileURL, timestamp: date, trigger: trigger, label: label))
        }

        let now = Date()
        let calendar = Calendar.current
        let h24ago = calendar.date(byAdding: .hour, value: -24, to: now)!
        let d7ago = calendar.date(byAdding: .day, value: -7, to: now)!
        let d30ago = calendar.date(byAdding: .day, value: -30, to: now)!

        var toDelete: [URL] = []

        // Group backups older than 24h but <= 7 days by calendar day, keep most recent per day
        let dayGroup = metas.filter { $0.timestamp <= h24ago && $0.timestamp > d7ago && $0.trigger != "manual" && $0.trigger != "pre-restore" && $0.label == nil }
        let byDay = Dictionary(grouping: dayGroup) { calendar.startOfDay(for: $0.timestamp) }
        for (_, group) in byDay {
            let sorted = group.sorted { $0.timestamp > $1.timestamp }
            for meta in sorted.dropFirst() {
                toDelete.append(meta.url)
            }
        }

        // Group backups older than 7 days but <= 30 days by calendar week, keep most recent per week
        let weekGroup = metas.filter { $0.timestamp <= d7ago && $0.timestamp > d30ago && $0.trigger != "manual" && $0.trigger != "pre-restore" && $0.label == nil }
        let byWeek = Dictionary(grouping: weekGroup) { meta -> Date in
            let comps = calendar.dateComponents([.yearForWeekOfYear, .weekOfYear], from: meta.timestamp)
            return calendar.date(from: comps) ?? meta.timestamp
        }
        for (_, group) in byWeek {
            let sorted = group.sorted { $0.timestamp > $1.timestamp }
            for meta in sorted.dropFirst() {
                toDelete.append(meta.url)
            }
        }

        // Delete all non-manual/non-labeled backups older than 30 days
        let oldGroup = metas.filter { $0.timestamp <= d30ago && $0.trigger != "manual" && $0.trigger != "pre-restore" && $0.label == nil }
        for meta in oldGroup {
            toDelete.append(meta.url)
        }

        for url in toDelete {
            try? fm.removeItem(at: url)
        }
    }

    /// Rebuilds the backups-index.json file by scanning all backup files.
    private func rebuildBackupsIndex() {
        guard let backupsDir = backupsDirectoryURL() else { return }

        let fm = FileManager.default
        guard let files = try? fm.contentsOfDirectory(at: backupsDir, includingPropertiesForKeys: nil) else { return }

        let backupFiles = files.filter { $0.lastPathComponent.hasPrefix("backup-") && $0.lastPathComponent.hasSuffix(".json") }

        var entries: [[String: Any]] = []
        for fileURL in backupFiles {
            guard let data = try? Data(contentsOf: fileURL),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }

            var entry: [String: Any] = [
                "filename": fileURL.lastPathComponent,
                "timestamp": json["timestamp"] as? String ?? "",
                "trigger": json["trigger"] as? String ?? "auto"
            ]
            if let label = json["label"] as? String {
                entry["label"] = label
            }
            if let summary = json["summary"] as? [String: Any] {
                entry["summary"] = summary
            }
            entries.append(entry)
        }

        // Sort newest first
        entries.sort { ($0["timestamp"] as? String ?? "") > ($1["timestamp"] as? String ?? "") }

        let indexURL = backupsDir.appendingPathComponent("backups-index.json")
        if let indexData = try? JSONSerialization.data(withJSONObject: entries, options: [.prettyPrinted]) {
            try? indexData.write(to: indexURL, options: .atomic)
        }
    }

    /// Appends a timestamped log line to debug/console.log. Auto-truncates at ~500KB.
    private func handleDebugLog(data: [String: Any]) -> [String: Any] {
        guard let debugDir = debugDirectoryURL() else {
            return ["success": false, "error": "Cannot access debug directory"]
        }

        let level = (data["level"] as? String ?? "LOG").uppercased()
        let source = data["source"] as? String ?? "unknown"
        let message = data["message"] as? String ?? ""

        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let timestamp = iso.string(from: Date())

        let line = "[\(timestamp)] [\(level)] [\(source)] \(message)\n"

        let fileURL = debugDir.appendingPathComponent("console.log")
        let fm = FileManager.default

        // Create file if it doesn't exist
        if !fm.fileExists(atPath: fileURL.path) {
            fm.createFile(atPath: fileURL.path, contents: nil)
        }

        // Append the line
        if let fileHandle = try? FileHandle(forWritingTo: fileURL) {
            fileHandle.seekToEndOfFile()
            if let lineData = line.data(using: .utf8) {
                fileHandle.write(lineData)
            }
            fileHandle.closeFile()
        }

        // Auto-truncate at ~500KB: keep last half
        if let attrs = try? fm.attributesOfItem(atPath: fileURL.path),
           let fileSize = attrs[.size] as? UInt64,
           fileSize > 500_000 {
            if let content = try? String(contentsOf: fileURL, encoding: .utf8) {
                let halfIndex = content.index(content.startIndex, offsetBy: content.count / 2)
                // Find next newline after the halfway point to avoid splitting a line
                let startIndex = content[halfIndex...].firstIndex(of: "\n").map { content.index(after: $0) } ?? halfIndex
                let truncated = String(content[startIndex...])
                try? truncated.write(to: fileURL, atomically: true, encoding: .utf8)
            }
        }

        return ["success": true]
    }

    /// Writes a DOM snapshot to debug/snapshot-{source}.html and state to debug/snapshot-{source}.json.
    private func handleDebugSnapshot(data: [String: Any]) -> [String: Any] {
        guard let debugDir = debugDirectoryURL() else {
            return ["success": false, "error": "Cannot access debug directory"]
        }

        let source = data["source"] as? String ?? "unknown"

        // Write HTML snapshot
        if let html = data["html"] as? String {
            let htmlURL = debugDir.appendingPathComponent("snapshot-\(source).html")
            try? html.write(to: htmlURL, atomically: true, encoding: .utf8)
        }

        // Write CSS snapshot
        if let css = data["css"] as? String {
            let cssURL = debugDir.appendingPathComponent("snapshot-\(source).css")
            try? css.write(to: cssURL, atomically: true, encoding: .utf8)
        }

        // Write JSON state (storage + meta)
        var jsonPayload: [String: Any] = [:]
        if let storage = data["storage"] as? [String: Any] {
            jsonPayload["storage"] = storage
        }
        if let meta = data["meta"] as? [String: Any] {
            jsonPayload["meta"] = meta
        }

        if !jsonPayload.isEmpty {
            let jsonURL = debugDir.appendingPathComponent("snapshot-\(source).json")
            if let jsonData = try? JSONSerialization.data(withJSONObject: jsonPayload, options: [.prettyPrinted, .sortedKeys]) {
                try? jsonData.write(to: jsonURL)
            }
        }

        return ["success": true]
    }

    /// Checks for a pending element inspector request file. Returns the selector and source if one exists.
    private func handleCheckElementInspectorRequest(data: [String: Any]) -> [String: Any] {
        guard let debugDir = debugDirectoryURL() else {
            return ["found": false]
        }

        let requestURL = debugDir.appendingPathComponent("element-request.json")
        guard FileManager.default.fileExists(atPath: requestURL.path),
              let requestData = try? Data(contentsOf: requestURL),
              let request = try? JSONSerialization.jsonObject(with: requestData) as? [String: Any],
              let selector = request["selector"] as? String else {
            return ["found": false]
        }

        let source = request["source"] as? String ?? "list"
        let callerSource = data["source"] as? String ?? ""

        // Only return the request if it matches this page's source
        if callerSource == source {
            // Delete the request file so it's only processed once
            try? FileManager.default.removeItem(at: requestURL)
            return ["found": true, "selector": selector, "source": source]
        }

        return ["found": false]
    }

    /// Writes element inspector results to debug/element-inspector-{source}.json.
    private func handleElementInspectorResult(data: [String: Any]) -> [String: Any] {
        guard let debugDir = debugDirectoryURL() else {
            return ["success": false, "error": "Cannot access debug directory"]
        }

        let source = data["source"] as? String ?? "unknown"
        let resultURL = debugDir.appendingPathComponent("element-inspector-\(source).json")

        // Write the full result payload as JSON
        if let jsonData = try? JSONSerialization.data(withJSONObject: data, options: [.prettyPrinted, .sortedKeys]) {
            try? jsonData.write(to: resultURL)
        }

        return ["success": true]
    }

    #if os(macOS)
    // Poll for AI result - processes tabs data if included in poll
    private func handlePollResult(data: [String: Any]) async -> [String: Any] {
        guard let requestId = data["requestId"] as? String else {
            return ["error": "Missing requestId"]
        }

        // Extract language (default to English if not provided)
        let language = data["language"] as? String ?? "en"

        // Check if this poll contains tabs data for immediate processing
        if let tabs = data["tabs"] as? [[String: Any]] {
            os_log(.info, "handlePollResult: Processing tabs data immediately for requestId: %@", requestId)

            guard #available(macOS 26.0, *) else {
                return ["error": "macOS 26.0 or later required for AI features"]
            }

            let startTime = Date()
            let result = await performCategorizeTabs(tabs: tabs, language: language, startTime: startTime)

            if let error = result["error"] as? String {
                os_log(.error, "handlePollResult: performCategorizeTabs returned error: %@", error)
            }

            return result
        }

        // Check if there's stored work to process
        if let workData = await pendingStore.takeWork(for: requestId) {
            // Process the work NOW (during this poll)
            guard #available(macOS 26.0, *),
                  let tabs = workData["tabs"] as? [[String: Any]] else {
                return ["error": "Invalid work data"]
            }

            // Extract language from stored work data (with fallback)
            let storedLanguage = workData["language"] as? String ?? language

            let startTime = Date()
            return await performCategorizeTabs(tabs: tabs, language: storedLanguage, startTime: startTime)
        }

        // No pending work, check if result is already ready
        if let result = await pendingStore.takeResult(for: requestId) {
            return result
        }

        return ["pending": true]
    }

    // MARK: - AI Request Handlers

    private func handlePing() async -> [String: Any] {
        if #available(macOS 26.0, *) {
            // Check actual Apple Intelligence availability
            let availability = SystemLanguageModel.default.availability

            switch availability {
            case .available:
                return ["status": "ready", "available": true]

            case .unavailable(let reason):
                switch reason {
                case .deviceNotEligible:
                    return [
                        "status": "unavailable",
                        "available": false,
                        "reason": "This device does not support Apple Intelligence."
                    ]

                case .appleIntelligenceNotEnabled:
                    return [
                        "status": "unavailable",
                        "available": false,
                        "reason": "Apple Intelligence is disabled. Enable it in System Settings."
                    ]

                case .modelNotReady:
                    return [
                        "status": "unavailable",
                        "available": false,
                        "reason": "Apple Intelligence is initializing. Please try again in a moment."
                    ]

                @unknown default:
                    return [
                        "status": "unavailable",
                        "available": false,
                        "reason": "Apple Intelligence is unavailable. Check System Settings."
                    ]
                }
            }
        } else {
            return ["status": "unavailable", "available": false, "reason": "macOS 26.0 or later required"]
        }
    }

    private func handleCheckAvailability() async -> [String: Any] {
        if #available(macOS 26.0, *) {
            // Use Apple's official availability checking API
            // Reference: https://developer.apple.com/documentation/FoundationModels/generating-content-and-performing-tasks-with-foundation-models#Check-for-availability
            let availability = SystemLanguageModel.default.availability

            switch availability {
            case .available:
                // Model is ready to use
                return ["status": "ready", "available": true, "supported": true]

            case .unavailable(let reason):
                // Handle specific unavailability reasons
                switch reason {
                case .deviceNotEligible:
                    // Device hardware doesn't support Apple Intelligence
                    return [
                        "status": "unavailable",
                        "available": false,
                        "supported": false,
                        "reason": "This device does not support Apple Intelligence."
                    ]

                case .appleIntelligenceNotEnabled:
                    // Apple Intelligence is turned off in System Settings
                    return [
                        "status": "unavailable",
                        "available": false,
                        "supported": true,
                        "reason": "Apple Intelligence is disabled. Enable it in System Settings."
                    ]

                case .modelNotReady:
                    // Model is downloading or initializing
                    return [
                        "status": "unavailable",
                        "available": false,
                        "supported": true,
                        "reason": "Apple Intelligence is initializing. Please try again in a moment."
                    ]

                @unknown default:
                    // Handle any future cases Apple might add
                    return [
                        "status": "unavailable",
                        "available": false,
                        "supported": true,
                        "reason": "Apple Intelligence is unavailable. Check System Settings."
                    ]
                }
            }
        } else {
            return ["status": "unavailable", "available": false, "supported": false, "reason": "macOS 26.0 or later required"]
        }
    }

    private func handleGenerateTitle(data: [String: Any]) async -> [String: Any] {
        guard #available(macOS 26.0, *) else {
            return ["error": "macOS 26.0 or later required for AI features"]
        }

        guard let tabs = data["tabs"] as? [[String: Any]] else {
            return ["error": "Invalid tabs data"]
        }

        // Extract language (default to English if not provided)
        let language = data["language"] as? String ?? "en"
        NSLog("[Tabstract] handleGenerateTitle: Using language: \(language)")

        // Retry logic: try up to 3 times with exponential backoff
        var lastError: String?
        for attempt in 1...3 {
            let result = await attemptGenerateTitle(tabs: tabs, language: language, attemptNumber: attempt)

            if let error = result["error"] as? String {
                lastError = error
                if attempt < 3 {
                    // Wait before retry: 1s, 2s
                    let delay = UInt64(attempt * 1_000_000_000)
                    try? await Task.sleep(nanoseconds: delay)
                    continue
                }
            } else if let _ = result["title"] {
                // Success
                return result
            }

            // If we got here, something unexpected happened
            break
        }

        return ["error": lastError ?? "Failed to generate title after 3 attempts"]
    }

    @available(macOS 26.0, *)
    private func attemptGenerateTitle(tabs: [[String: Any]], language: String, attemptNumber: Int) async -> [String: Any] {
        // Limit to 20 tabs to avoid token overflow
        let limitedTabs = Array(tabs.prefix(20))

        // Create prompt from tab data (include title, URL, and og:description for better context)
        let tabDescriptions = limitedTabs.compactMap { tab -> String? in
            guard let title = tab["title"] as? String, let url = tab["url"] as? String else { return nil }
            let host = URL(string: url)?.host ?? url
            var note = ""
            if let status = tab["status"] as? Int {
                note = ", status \(status)"
            } else if let statusStr = tab["status"] as? String, !statusStr.isEmpty {
                note = ", status \(statusStr)"
            }
            var hints = ""
            if let h = tab["hints"] as? String, !h.isEmpty { hints = ", hints: \(h)" }
            var desc = ""
            if let ogDesc = tab["ogDescription"] as? String, !ogDesc.isEmpty { desc = ", desc: \(ogDesc)" }
            return "- \(title) (\(host)\(note)\(hints)\(desc))"
        }.joined(separator: "\n")

        // Generate localized prompt
        let prompt = getTitlePrompt(tabDescriptions: tabDescriptions, language: language)
        NSLog("[Tabstract] Prompt language: \(language), Prompt preview: \(String(prompt.prefix(100)))")

        do {
            // Create language-specific model session
            let systemPrompt = getSystemPrompt(for: language)
            let session = LanguageModelSession {
                systemPrompt
            }

            // Use guided generation for structured output
            let response = try await session.respond(to: prompt, generating: TitleResponse.self)
            let cleanTitle = response.content.title.trimmingCharacters(in: .whitespacesAndNewlines)
            NSLog("[Tabstract] AI returned title: \(cleanTitle) (language: \(language))")

            // Basic validation
            if cleanTitle.isEmpty || cleanTitle.count < 2 {
                return ["error": "Generated title too short or empty"]
            }

            let wordCount = cleanTitle.split(separator: " ").count

            // Reject if too long
            if wordCount > 6 || cleanTitle.count > 60 {
                return ["error": "Generated title too long"]
            }

            return ["title": cleanTitle]

        } catch {
            os_log(.error, "Foundation Models error: %@", error.localizedDescription)

            // Provide more specific error messages
            if error.localizedDescription.contains("unavailable") {
                return ["error": "AI models not available. Please enable Apple Intelligence in System Settings."]
            } else if error.localizedDescription.contains("token") {
                return ["error": "Too many tabs to process. Try with fewer tabs."]
            } else {
                return ["error": error.localizedDescription]
            }
        }
    }

    private func handleCategorizeTabs(data: [String: Any]) async -> [String: Any] {
        guard #available(macOS 26.0, *) else {
            return ["error": "macOS 26.0 or later required for AI features"]
        }

        guard let tabs = data["tabs"] as? [[String: Any]] else {
            return ["error": "Invalid tabs data"]
        }

        // Extract language (default to English if not provided)
        let language = data["language"] as? String ?? "en"
        NSLog("[Tabstract] handleCategorizeTabs: Using language: \(language)")

        let requestId = data["requestId"] as? String

        // If we have a requestId, store work for processing on first poll
        if let requestId = requestId {
            await pendingStore.setWork(["tabs": tabs, "language": language, "timestamp": Date().timeIntervalSince1970], for: requestId)

            // Return acknowledgment immediately
            return ["acknowledged": true, "requestId": requestId]
        }

        // Fallback: synchronous processing (without requestId)
        let startTime = Date()
        return await performCategorizeTabs(tabs: tabs, language: language, startTime: startTime)
    }

    @available(macOS 26.0, *)
    private func performCategorizeTabs(tabs: [[String: Any]], language: String, startTime: Date) async -> [String: Any] {
        os_log(.info, "performCategorizeTabs started with %d tabs and language %@", tabs.count, language)

        // Limit to 50 tabs (batching happens in JavaScript for larger sets)
        let limitedTabs = Array(tabs.prefix(50))

        // Create prompt with indexed tabs
        var tabDescriptions = ""
        for (index, tab) in limitedTabs.enumerated() {
            guard let title = tab["title"] as? String, let url = tab["url"] as? String else { continue }
            let host = URL(string: url)?.host ?? url
            var note = ""
            if let status = tab["status"] as? Int {
                note = ", status \(status)"
            } else if let statusStr = tab["status"] as? String, !statusStr.isEmpty {
                note = ", status \(statusStr)"
            }
            var hints = ""
            if let h = tab["hints"] as? String, !h.isEmpty { hints = ", hints: \(h)" }
            var desc = ""
            if let ogDesc = tab["ogDescription"] as? String, !ogDesc.isEmpty { desc = ", desc: \(ogDesc)" }
            tabDescriptions += "\(index): \(title) (\(host)\(note)\(hints)\(desc))\n"
        }

        // Generate localized prompt
        let prompt = getCategorizationPrompt(tabDescriptions: tabDescriptions, language: language)
        NSLog("[Tabstract] Categorization language: \(language), Prompt end: \(String(prompt.suffix(200)))")

        do {
            // Create language-specific model session
            let systemPrompt = getSystemPrompt(for: language)
            let session = LanguageModelSession {
                systemPrompt
            }

            os_log(.info, "performCategorizeTabs: Calling AI model with prompt length %d", prompt.count)
            os_log(.info, "performCategorizeTabs: First 3 tabs with descriptions:\n%@", String(tabDescriptions.split(separator: "\n").prefix(3).joined(separator: "\n")))

            // Use guided generation for structured output
            let response = try await session.respond(to: prompt, generating: CategorizeResponse.self)

            os_log(.info, "performCategorizeTabs: Received response with %d categories", response.content.categories.count)
            NSLog("[Tabstract] Categorization returned: \(response.content.categories.map { $0.name }.joined(separator: ", "))")

            // Convert to dictionary format for JavaScript
            var validCategories: [[String: Any]] = []
            for category in response.content.categories {
                // Filter valid indices only
                let validIndices = category.tabIndices.filter { $0 >= 0 && $0 < limitedTabs.count }
                if !validIndices.isEmpty {
                    validCategories.append([
                        "name": category.name,
                        "tabIndices": validIndices
                    ])
                }
            }

            if validCategories.isEmpty {
                os_log(.error, "performCategorizeTabs: No valid categories after filtering")
                return ["error": "No valid categories generated"]
            }

            os_log(.info, "performCategorizeTabs: Returning %d valid categories", validCategories.count)
            return ["categories": validCategories]

        } catch {
            os_log(.error, "performCategorizeTabs: Exception caught: %@", error.localizedDescription)
            if error.localizedDescription.contains("unavailable") {
                return ["error": "AI models not available. Please enable Apple Intelligence in System Settings."]
            } else if error.localizedDescription.contains("token") {
                return ["error": "Too many tabs to process. Try with fewer tabs."]
            } else {
                return ["error": error.localizedDescription]
            }
        }
    }

    // MARK: - Two‑Phase Categorization

    private func handleExtractThemes(data: [String: Any]) async -> [String: Any] {
        guard #available(macOS 26.0, *) else {
            return ["error": "macOS 26.0 or later required for AI features"]
        }

        // Check if this is a poll with tabs data
        guard let tabs = data["tabs"] as? [[String: Any]] else {
            // No tabs data - return pending (shouldn't happen with our polling pattern)
            return ["pending": true]
        }

        // Extract language (default to English if not provided)
        let language = data["language"] as? String ?? "en"

        // Limit to 40 tabs for theme discovery
        let limitedTabs = Array(tabs.prefix(40))

        // Build indexed tab list
        var tabDescriptions = ""
        for (index, tab) in limitedTabs.enumerated() {
            guard let title = tab["title"] as? String, let url = tab["url"] as? String else { continue }
            let host = URL(string: url)?.host ?? url
            var note = ""
            if let status = tab["status"] as? Int {
                note = ", status \(status)"
            } else if let statusStr = tab["status"] as? String, !statusStr.isEmpty {
                note = ", status \(statusStr)"
            }
            var hints = ""
            if let h = tab["hints"] as? String, !h.isEmpty { hints = ", hints: \(h)" }
            var desc = ""
            if let ogDesc = tab["ogDescription"] as? String, !ogDesc.isEmpty { desc = ", desc: \(ogDesc)" }
            tabDescriptions += "\(index): \(title) (\(host)\(note)\(hints)\(desc))\n"
        }

        // Generate localized prompt
        let prompt = getThemeExtractionPrompt(tabDescriptions: tabDescriptions, language: language)

        do {
            // Create language-specific model session
            let systemPrompt = getSystemPrompt(for: language)
            let session = LanguageModelSession {
                systemPrompt
            }

            // Use guided generation for structured output
            let response = try await session.respond(to: prompt, generating: ThemesResponse.self)

            // Convert to dictionary format for JavaScript
            let validThemes: [[String: Any]] = response.content.themes.map { theme in
                return [
                    "name": theme.name.trimmingCharacters(in: .whitespacesAndNewlines),
                    "description": theme.description.trimmingCharacters(in: .whitespacesAndNewlines)
                ]
            }

            if validThemes.isEmpty { return ["error": "No themes generated"] }
            return ["themes": validThemes]
        } catch {
            return ["error": error.localizedDescription]
        }
    }

    private func handleAssignTabsToThemes(data: [String: Any]) async -> [String: Any] {
        guard #available(macOS 26.0, *) else {
            return ["error": "macOS 26.0 or later required for AI features"]
        }

        guard let tabs = data["tabs"] as? [[String: Any]],
              let themes = data["themes"] as? [[String: Any]] else {
            return ["error": "Invalid input data"]
        }

        // Extract language (default to English if not provided)
        let language = data["language"] as? String ?? "en"

        // Build themes list for the prompt
        var themesList = ""
        for (idx, theme) in themes.enumerated() {
            let name = (theme["name"] as? String) ?? "Theme \(idx+1)"
            let desc = (theme["description"] as? String) ?? ""
            themesList += "\(idx): \(name) — \(desc)\n"
        }

        // Build full tab list (assign across all tabs)
        var tabDescriptions = ""
        for (index, tab) in tabs.enumerated() {
            guard let title = tab["title"] as? String, let url = tab["url"] as? String else { continue }
            let host = URL(string: url)?.host ?? url
            var note = ""
            if let status = tab["status"] as? Int {
                note = ", status \(status)"
            } else if let statusStr = tab["status"] as? String, !statusStr.isEmpty {
                note = ", status \(statusStr)"
            }
            var hints = ""
            if let h = tab["hints"] as? String, !h.isEmpty { hints = ", hints: \(h)" }
            var desc = ""
            if let ogDesc = tab["ogDescription"] as? String, !ogDesc.isEmpty { desc = ", desc: \(ogDesc)" }
            tabDescriptions += "\(index): \(title) (\(host)\(note)\(hints)\(desc))\n"
        }

        // Generate localized prompt
        let prompt = getThemeAssignmentPrompt(themesList: themesList, tabDescriptions: tabDescriptions, language: language)

        do {
            // Create language-specific model session
            let systemPrompt = getSystemPrompt(for: language)
            let session = LanguageModelSession {
                systemPrompt
            }

            // Use guided generation for structured output
            let response = try await session.respond(to: prompt, generating: CategorizeResponse.self)

            // Validate and clean categories
            let themeNames = Set(themes.compactMap { $0["name"] as? String })
            var categories: [[String: Any]] = []
            for category in response.content.categories {
                // Only include categories that match provided theme names
                guard themeNames.contains(category.name) else { continue }

                let validIdx = category.tabIndices.filter { $0 >= 0 && $0 < tabs.count }
                if !validIdx.isEmpty {
                    categories.append(["name": category.name, "tabIndices": validIdx])
                }
            }

            if categories.isEmpty { return ["error": "No valid assignments"] }
            return ["categories": categories]
        } catch {
            return ["error": error.localizedDescription]
        }
    }

    #endif // os(macOS) — AI methods

    // MARK: - iCloud Sync Handlers

    @available(macOS 12.0, iOS 16.0, *)
    private static let syncEngine = CloudKitSyncEngine()

    @available(macOS 12.0, iOS 16.0, *)
    private func handleSyncEnable() async -> [String: Any] {
        let engine = SafariWebExtensionHandler.syncEngine

        // Check account status with timeout OUTSIDE actor to avoid deadlock
        let accountResult: [String: Any]
        do {
            accountResult = try await withThrowingTimeout(seconds: 10) {
                await engine.checkAccountStatus()
            }
        } catch {
            return ["success": false, "error": "timeout", "accountStatus": "timeout"]
        }
        guard let status = accountResult["status"] as? String, status == "available" else {
            let errorStatus = accountResult["status"] as? String ?? "unknown"
            return ["success": false, "error": "noAccount", "accountStatus": errorStatus]
        }

        // Create zone if needed
        do {
            try await withThrowingTimeout(seconds: 15) {
                try await engine.ensureZoneExists()
            }
        } catch is SyncTimeoutError {
            await engine.updateLastError("timeout")
            return ["success": false, "error": "timeout"]
        } catch {
            let errorStr = engine.mapCKError(error)
            await engine.updateLastError(errorStr)
            return ["success": false, "error": errorStr]
        }

        // Clear stale change token so the first pull does a full fetch
        await engine.clearChangeToken()

        // Mark enabled and return device ID
        await engine.setEnabled(true)
        let deviceID = await engine.getOrCreateDeviceID()

        return ["success": true, "deviceID": deviceID, "accountStatus": "available"]
    }

    @available(macOS 12.0, iOS 16.0, *)
    private func handleSyncDisable() async -> [String: Any] {
        let engine = SafariWebExtensionHandler.syncEngine
        await engine.setEnabled(false)
        return ["success": true]
    }

    @available(macOS 12.0, iOS 16.0, *)
    private func handleSyncStatus() async -> [String: Any] {
        let engine = SafariWebExtensionHandler.syncEngine

        var result = await engine.getSyncStatus()

        // Check current account status with timeout outside actor
        let accountResult: [String: Any]
        do {
            accountResult = try await withThrowingTimeout(seconds: 10) {
                await engine.checkAccountStatus()
            }
        } catch {
            accountResult = ["status": "timeout"]
        }
        let accountStatus = accountResult["status"] as? String ?? "unknown"
        result["accountStatus"] = accountStatus
        result["success"] = true

        // Clear stale auth errors — notAuthenticated is transient, not persisted
        if let lastError = result["lastError"] as? String, lastError == "notAuthenticated" {
            result["lastError"] = nil
            await engine.clearLastError()
        }

        return result
    }

    @available(macOS 12.0, iOS 16.0, *)
    private func handleSyncPush(data: [String: Any]) async -> [String: Any] {
        let engine = SafariWebExtensionHandler.syncEngine

        // Check account before attempting CloudKit operations (timeout outside actor)
        let accountResult: [String: Any]
        do {
            accountResult = try await withThrowingTimeout(seconds: 10) {
                await engine.checkAccountStatus()
            }
        } catch {
            return ["success": false, "error": "timeout"]
        }
        guard let status = accountResult["status"] as? String else {
            return ["success": false, "error": "notAuthenticated"]
        }
        if status == "noAccount" || status == "restricted" {
            return ["success": false, "error": "notAuthenticated"]
        }
        if status != "available" {
            return ["success": false, "error": "temporarilyUnavailable"]
        }

        // Detect iCloud account switch — re-create zone if needed
        // forceCheck: false skips the network call when userRecordID is already stored
        let sameAccount = await engine.checkForAccountSwitch(forceCheck: false)
        if !sameAccount {
            do { try await engine.ensureZoneExists() } catch {
                return ["success": false, "error": engine.mapCKError(error)]
            }
        }

        guard let records = data["records"] as? [[String: Any]] else {
            return ["success": false, "error": "Missing records"]
        }

        let result = await engine.pushRecords(records: records)
        return result
    }

    @available(macOS 12.0, iOS 16.0, *)
    private func handleSyncPull() async -> [String: Any] {
        let engine = SafariWebExtensionHandler.syncEngine

        // Check account before attempting CloudKit operations (timeout outside actor)
        let accountResult: [String: Any]
        do {
            accountResult = try await withThrowingTimeout(seconds: 10) {
                await engine.checkAccountStatus()
            }
        } catch {
            return ["success": false, "error": "timeout"]
        }
        guard let status = accountResult["status"] as? String else {
            return ["success": false, "error": "notAuthenticated"]
        }
        if status == "noAccount" || status == "restricted" {
            return ["success": false, "error": "notAuthenticated"]
        }
        if status != "available" {
            return ["success": false, "error": "temporarilyUnavailable"]
        }

        // Detect iCloud account switch — clear token and re-create zone if needed
        // forceCheck: false skips the network call when userRecordID is already stored
        let sameAccount = await engine.checkForAccountSwitch(forceCheck: false)
        if !sameAccount {
            do { try await engine.ensureZoneExists() } catch {
                return ["success": false, "error": engine.mapCKError(error)]
            }
        }

        let result = await engine.pullChanges()

        if result["success"] as? Bool == true {
            await engine.updateLastSyncTime()
        } else if let error = result["error"] as? String,
                  error != "notAuthenticated" && error != "temporarilyUnavailable" {
            await engine.updateLastError(error)
        }

        return result
    }

}
