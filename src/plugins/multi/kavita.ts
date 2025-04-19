import { fetchApi, fetchProto, fetchText } from '@libs/fetch';
import { Plugin } from '@typings/plugin';
import { Filters } from '@libs/filterInputs';
import { NovelStatus } from '@libs/novelStatus';
import { storage, localStorage, sessionStorage } from '@libs/storage';

class KavitaPlugin implements Plugin.PluginBase {
  id = 'kavita';
  name = 'Kavita';
  icon = 'src/multi/kavita/icon.png';

  site = storage.get('url');
  apiKey = storage.get('apiKey');
  version = '1.0.1';
  filters: Filters | undefined = undefined;
  imageRequestInit?: Plugin.ImageRequestInit | undefined = undefined;

  user?: KavitaUser;

  //flag indicates whether access to LocalStorage, SesesionStorage is required.
  webStorageUtilized?: boolean = true;

  getSite() {
    if (!this.site) {
      this.site = storage.get('url');
    }
    if (!this.site) {
      throw new Error('Must configure a valid URL');
    }
    if (this.site.endsWith('/')) {
      return this.site;
    }
    return this.site + '/';
  }

  async genHeaders(inputHeaders?: any) {
    if (!this.apiKey) {
      this.apiKey = storage.get('apiKey');
    }

    if (!this.apiKey) {
      throw new Error('Must enter a valid api key');
    }

    // Get user from storage if exists
    if (this.user === undefined || this.user.token === undefined) {
      this.user = storage.get('user') || undefined;
    }

    // User does not exist in storage, log in from kavita
    if (this.user === undefined || this.user.token === undefined) {
      this.user = await fetchApi(`${this.getSite()}api/Account/login`, {
        method: 'POST',
        body: JSON.stringify({
          username: '',
          password: '',
          apiKey: this.apiKey,
        }),
        headers: { 'Content-Type': 'application/json' },
      }).then(res => res.json());
      storage.set('user', this.user);
    }

    if (this.user === undefined || this.user.token === undefined) {
      throw new Error('Unable to log into kavita');
    }

    // Check token to see if it expired
    let parsedToken = parseJwt(this.user.token);
    if (Date.now() >= parsedToken.exp * 1000) {
      let newTokens = await fetchApi(
        `${this.getSite()}api/Account/refresh-token`,
        {
          method: 'POST',
          body: JSON.stringify({
            token: this.user.token,
            refreshToken: this.user.refreshToken,
          }),
          headers: { 'Content-Type': 'application/json' },
        },
      ).then(res => res.json());
      this.user.token = newTokens.token;
      this.user.refreshToken = newTokens.refreshToken;
      storage.set('user', this.user);
    }

    let output: any;
    if (inputHeaders !== undefined) {
      output = { ...inputHeaders };
    } else {
      output = {};
    }

    output['Authorization'] = `Bearer ${this.user.token}`;

    return output;
  }

  async getNovelsByFilter(
    filter: KavitaSearchFilter,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    const novels: Plugin.NovelItem[] = [];
    let req = await fetchApi(
      `${this.getSite()}api/series/all-v2?pageNumber=${pageNo}&pageSize=20`,
      {
        method: 'POST',
        body: JSON.stringify(filter),
        headers: await this.genHeaders({ 'Content-Type': 'application/json' }),
      },
    );

    let data: KavitaSeries[];
    try {
      data = await req.json();
    } catch (e) {
      throw new Error('Failed to load novel series from kavita.');
    }

    for (const item of data) {
      let req: KavitaSeriesDetail = await fetchApi(
        `${this.getSite()}api/series/series-detail?seriesId=${item.id}`,
        {
          headers: await this.genHeaders(),
        },
      ).then(req => req.json());
      let volumes = req.volumes || [];
      for (const volume of volumes) {
        let chapters = volume.chapters || [];
        for (const chapter of chapters) {
          novels.push({
            name: chapter.titleName,
            path: `${item.libraryId}/${item.id}/${chapter.id.toString()}`,
            cover: `${this.getSite()}api/Image/chapter-cover?chapterId=${chapter.id}&apiKey=${this.apiKey}`,
          });
        }
      }
    }

    return novels;
  }

  async popularNovels(
    pageNo: number,
    {
      showLatestNovels,
      filters,
    }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    let request_filters: KavitaSearchFilter = {
      id: 0,
      name: '',
      statements: [
        {
          comparison: KavitaFilterComparison.Contains,
          field: KavitaField.Formats,
          value: KavitaFormats.Epub,
        },
      ],
      combinations: 1,
      sortOptions: {
        sortField: 1,
        isAscending: true,
      },
      limitTo: 0,
    };
    return this.getNovelsByFilter(request_filters, pageNo);
  }

  parseKavitaChapters(
    inputChapters: KavitaBookChapter[],
    start_page_range: number,
    end_page_range: number,
    chapter_index_start: number,
    release_date: string,
    library_id: string,
    series_id: string,
    chapter_id: string,
  ): Plugin.ChapterItem[] {
    const chapters: Plugin.ChapterItem[] = [];

    let chapter_index = chapter_index_start;
    for (const chapter of inputChapters) {
      let children = chapter.children || [];
      let end_page = end_page_range;
      if (chapter_index < inputChapters.length - 1) {
        end_page = inputChapters[chapter_index + 1].page - 1;
      }

      if (children.length > 0) {
        let processed_children = this.parseKavitaChapters(
          children,
          chapter.page,
          end_page,
          chapter_index,
          release_date,
          library_id,
          series_id,
          chapter_id,
        );
        chapter_index += processed_children.length;
        chapters.push(...processed_children);
        continue;
      }

      const c: Plugin.ChapterItem = {
        name: chapter.title,
        path: `${library_id}/${series_id}/${chapter_id}/${chapter_index}/${chapter.page}/${end_page}`,
        releaseTime: release_date,
        chapterNumber: chapter_index,
      };
      chapters.push(c);
      chapter_index++;
    }

    return chapters;
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const [library_id, series_id, chapter_id] = novelPath.split('/', 3);
    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name: 'Untitled',
    };

    let req = await fetchApi(
      `${this.getSite()}api/Chapter?chapterId=${chapter_id}`,
      {
        headers: await this.genHeaders(),
      },
    );

    let data: KavitaChapterDetail;
    try {
      data = await req.json();
    } catch (e) {
      throw new Error('Failed to load novel from kavita.');
    }

    novel.name = data.titleName;
    novel.artist = (data.coverArtists || [])
      .filter(i => i.name)
      .map(i => i.name)
      .join(', ');
    novel.author = (data.writers || [])
      .filter(i => i.name)
      .map(i => i.name)
      .join(', ');
    novel.cover = `${this.getSite()}api/Image/chapter-cover?chapterId=${data.id}&apiKey=${this.apiKey}`;
    novel.genres = (data.genres || []).map(i => i.title).join(', ');
    novel.status = convert_kavita_publication_status(data.publicationStatus);
    novel.summary = data.summary;

    let chapter_req = await fetchApi(
      `${this.getSite()}api/Book/${data.id}/chapters`,
      {
        headers: await this.genHeaders(),
      },
    );

    let chapter_data: KavitaBookChapter[];
    try {
      chapter_data = await chapter_req.json();
    } catch (e) {
      throw new Error('Failed to load novel chapters from kavita.');
    }

    novel.chapters = this.parseKavitaChapters(
      chapter_data,
      0,
      data.pages,
      0,
      data.releaseDate,
      library_id,
      series_id,
      chapter_id,
    );
    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    // parse chapter text here
    const [
      library_id,
      series_id,
      chapter_id,
      chapter_number,
      start_page,
      end_page,
    ] = chapterPath.split('/', 6);

    let text = '';

    for (let page = parseInt(start_page); page <= parseInt(end_page); page++) {
      let req = await fetchApi(
        `${this.getSite()}api/Book/${chapter_id}/book-page?page=${page}`,
        {
          headers: await this.genHeaders(),
        },
      );

      try {
        text += await req.text();
      } catch (e) {
        throw new Error('Failed to load chapter from kavita.');
      }
    }

    return text;
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    let request_filters: KavitaSearchFilter = {
      id: 0,
      name: '',
      statements: [
        {
          comparison: KavitaFilterComparison.Contains,
          field: KavitaField.Formats,
          value: KavitaFormats.Epub,
        },
        {
          comparison: KavitaFilterComparison.Matches,
          field: KavitaField.SeriesName,
          value: searchTerm,
        },
      ],
      combinations: 1,
      sortOptions: {
        sortField: 1,
        isAscending: true,
      },
      limitTo: 0,
    };

    return this.getNovelsByFilter(request_filters, pageNo);
  }

  resolveUrl(path: string, isNovel?: boolean): string {
    if (isNovel) {
      const [library_id, series_id, chapter_id] = path.split('/', 3);
      return `${this.getSite}/library/${library_id}/series/${series_id}/chapter/${chapter_id}`;
    }
    const [
      library_id,
      series_id,
      chapter_id,
      chapter_number,
      start_page,
      end_page,
    ] = path.split('/', 6);
    return `${this.getSite}/library/${library_id}/series/${series_id}/chapter/${chapter_id}`;
  }

  pluginSettings = {
    url: {
      value: '',
      label: 'URL',
      type: 'Text',
    },
    apiKey: {
      value: '',
      label: 'Api Key',
      type: 'Text',
    },
  };
}

export default new KavitaPlugin();

function convert_kavita_publication_status(
  status: KavitaPublicationStatus,
): string {
  switch (status) {
    case KavitaPublicationStatus.Cancelled:
      return NovelStatus.Cancelled;
    case KavitaPublicationStatus.Completed:
      return NovelStatus.Completed;
    case KavitaPublicationStatus.Ended:
      return NovelStatus.PublishingFinished;
    case KavitaPublicationStatus.Hiatus:
      return NovelStatus.OnHiatus;
    case KavitaPublicationStatus.OnGoing:
      return NovelStatus.Ongoing;
  }
}

const chars =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
function btoa(input: string = '') {
  let str = input;
  let output = '';

  for (
    let block = 0, charCode, i = 0, map = chars;
    str.charAt(i | 0) || ((map = '='), i % 1);
    output += map.charAt(63 & (block >> (8 - (i % 1) * 8)))
  ) {
    charCode = str.charCodeAt((i += 3 / 4));

    if (charCode > 0xff) {
      throw new Error(
        "'btoa' failed: The string to be encoded contains characters outside of the Latin1 range.",
      );
    }

    block = (block << 8) | charCode;
  }

  return output;
}

function atob(input: string = '') {
  let str = input.replace(/=+$/, '');
  let output = '';

  if (str.length % 4 == 1) {
    throw new Error(
      "'atob' failed: The string to be decoded is not correctly encoded.",
    );
  }

  for (
    let bc = 0, bs = 0, buffer, i = 0;
    (buffer = str.charAt(i++));
    ~buffer && ((bs = bc % 4 ? bs * 64 + buffer : buffer), bc++ % 4)
      ? (output += String.fromCharCode(255 & (bs >> ((-2 * bc) & 6))))
      : 0
  ) {
    buffer = chars.indexOf(buffer);
  }

  return output;
}

function parseJwt(token: string): ParsedToken {
  var base64Url = token.split('.')[1];
  var base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  var jsonPayload = decodeURIComponent(
    atob(base64)
      .split('')
      .map(function (c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
      })
      .join(''),
  );
  return JSON.parse(jsonPayload);
}

// function parseJwt (token: string): ParsedToken {
//     return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
// }

type KavitaBookChapter = {
  title: string;
  part?: string;
  page: number;
  children?: KavitaBookChapter[];
};

type KavitaSeries = {
  id: number;
  name: string;
  originalName: string;
  localizedName: string;
  sortName: string;
  pages: number;
  coverImageLocked: boolean;
  pagesRead: number;
  latestReadDate: string;
  lastChapterAdded: string;
  userRating: number;
  hasUserRated: boolean;
  format: number;
  created: string;
  nameLocked: boolean;
  sortNameLocked: boolean;
  localizedNameLocked: boolean;
  wordCount: number;
  libraryId: number;
  libraryName: string;
  minHoursToRead: number;
  maxHoursToRead: number;
  avgHoursToRead: number;
  folderPath: string;
  lowestFolderPath: string;
  lastFolderScanned: string;
  dontMatch: boolean;
  isBlacklisted: boolean;
  coverImage: string;
  primaryColor: string;
  secondaryColor: string;
};

type KavitaSeriesDetail = {
  specials?: KavitaChapterDetail[];
  chapters?: KavitaChapterDetail[];
  volumes?: KavitaVolumeDetail[];
  storylineChapters?: KavitaChapterDetail[];
  unreadCount: number;
  totalCount: number;
};

type KavitaVolumeDetail = {
  id: number;
  minNumber: number;
  maxNumber: number;
  name: string;
  pages: number;
  pagesRead: number;
  lastModifiedUtc: string;
  createdUtc: string;
  created: string;
  lastModified: string;
  seriesId: number;
  chapters?: KavitaChapterDetail[];
  minHoursToRead: number;
  maxHoursToRead: number;
  avgHoursToRead: number;
  wordCount: number;
  coverImage?: string;
  primaryColor?: string;
  secondaryColor?: string;
};
type KavitaChapterDetail = {
  id: number;
  range?: string;
  minNumber: number;
  maxNumber: number;
  sortOrder: number;
  pages: number;
  isSpecial: boolean;
  title?: string;
  files?: KavitaFileDetail[];
  pagesRead: number;
  lastReadingProgressUtc: string;
  lastReadingProgress: string;
  coverImageLocked: boolean;
  volumeId: number;
  createdUtc: string;
  lastModifiedUtc: string;
  created: string;
  releaseDate: string;
  titleName: string;
  summary: string;
  ageRating: number;
  wordCount: number;
  volumeTitle: string;
  minHoursToRead: number;
  maxHoursToRead: number;
  avgHoursToRead: number;
  webLinks?: string;
  isbn?: string;
  writers?: KavitaPersonDetail[];
  coverArtists?: KavitaPersonDetail[];
  publishers?: KavitaPersonDetail[];
  characters?: KavitaPersonDetail[];
  pencillers?: KavitaPersonDetail[];
  inkers?: KavitaPersonDetail[];
  imprints?: KavitaPersonDetail[];
  colorists?: KavitaPersonDetail[];
  letterers?: KavitaPersonDetail[];
  editors?: KavitaPersonDetail[];
  translators?: KavitaPersonDetail[];
  teams?: KavitaPersonDetail[];
  locations?: KavitaPersonDetail[];
  genres?: KavitaGenreDetail[];
  tags?: KavitaTagDetail[];
  publicationStatus: KavitaPublicationStatus;
  language?: string;
  count: number;
  totalCount: number;
  languageLocked: boolean;
  summaryLocked: boolean;
  ageRatingLocked: boolean;
  publicationStatusLocked: boolean;
  genresLocked: boolean;
  tagsLocked: boolean;
  writerLocked: boolean;
  characterLocked: boolean;
  coloristLocked: boolean;
  editorLocked: boolean;
  inkerLocked: boolean;
  imprintLocked: boolean;
  lettererLocked: boolean;
  pencillerLocked: boolean;
  publisherLocked: boolean;
  translatorLocked: boolean;
  teamLocked: boolean;
  locationLocked: boolean;
  coverArtistLocked: boolean;
  releaseYearLocked: boolean;
  coverImage?: string;
  primaryColor?: string;
  secondaryColor?: string;
};

type KavitaPersonDetail = {
  id: number;
  name?: string;
  coverImageLocked: boolean;
  primaryColor?: string;
  secondaryColor?: string;
  coverImage?: string;
  description?: string;
  asin?: string;
  aniListId: number;
  malId: number;
  hardcoverId?: string;
};

type KavitaGenreDetail = {
  id: number;
  title: string;
};

type KavitaTagDetail = {
  id: number;
  title: string;
};

type KavitaFileDetail = {
  id: number;
  filePath?: string;
  pages: number;
  bytes: number;
  format: KavitaFormats;
  created: string;
  extension?: string;
};

type ParsedToken = {
  name: string;
  nameid: number;
  role: string[];
  nbf: number;
  exp: number;
  iat: number;
};

type KavitaUser = {
  username: string;
  email: string;
  token: string;
  refreshToken: string;
  apiKey: string;
  preferences: any;
  ageRestriction: {
    ageRating: number;
    includeUnknown: boolean;
  };
  kavitaVersion: number;
};

enum KavitaFormats {
  Image = '0',
  Archive = '1',
  Unknown = '2',
  Epub = '3',
  Pdf = '4',
}

enum KavitaPublicationStatus {
  OnGoing = 0,
  Hiatus = 1,
  Completed = 2,
  Cancelled = 3,
  Ended = 4,
}

enum KavitaField {
  Summary = 0,
  SeriesName = 1,
  PublicationStatus = 2,
  Languages = 3,
  AgeRating = 4,
  UserRating = 5,
  Tags = 6,
  CollectionTags = 7,
  Translators = 8,
  Characters = 9,
  Publisher = 10,
  Editor = 11,
  CoverArtist = 12,
  Letterer = 13,
  Colorist = 14,
  Inker = 15,
  Penciller = 16,
  Writers = 17,
  Genres = 18,
  Libraries = 19,
  ReadProgress = 20,
  Formats = 21,
  ReleaseYear = 22,
  ReadTime = 23,
  Path = 24,
  FilePath = 25,
}

enum KavitaFilterComparison {
  Equal = 0,
  GreaterThan = 1,
  GreaterThanEqual = 2,
  LessThan = 3,
  LessThanEqual = 4,
  Contains = 5,
  MustContains = 6,
  Matches = 7,
  NotContains = 8,
  NotEqual = 9,
  BeginsWith = 10,
  EndsWith = 11,
  IsBefore = 12,
  IsAfter = 13,
  IsInLast = 14,
  IsNotInLast = 15,
}

type KavitaSearchFilterStatement = {
  comparison: KavitaFilterComparison;
  field: KavitaField;
  value: string;
};

type KavitaSearchFilter = {
  id: number;
  name: string;
  statements: KavitaSearchFilterStatement[];
  combinations: number;
  sortOptions: {
    sortField: KavitaField;
    isAscending: boolean;
  };
  limitTo: number;
};
