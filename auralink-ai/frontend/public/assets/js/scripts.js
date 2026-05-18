
$(function () {

    "use strict";
    
    $(function () {

        var equalWidth = $(".brand-ds .item").outerWidth();

        $(".brand-ds .item").css({
            "height": equalWidth
        });

    }); 

    var testim = new Swiper(".testimonials-ds .testim-swiper", {
        slidesPerView: 1,
        spaceBetween: 30,
        speed: 1500,
        autoplay: {
            delay: 3000,
            disableOnInteraction: false,
        },
        loop: true,
        pagination: {
            el: ".swiper-pagination",
            clickable: true,
        },
    });

    var workswip = new Swiper(".works-ds .work-swiper", {
        slidesPerView: "auto",
        spaceBetween: 30,
        speed: 1500,
        autoplay: {
            delay: 3000,
            disableOnInteraction: false,
        },
        loop: true,
        pagination: {
            el: ".works-ds .swiper-pagination",
            clickable: true,
        },

        breakpoints: {
            0: {
                slidesPerView: "auto",
            },
            640: {
                slidesPerView: "auto",
            },
            768: {
                slidesPerView: "auto",
            },
            1024: {
                slidesPerView: "auto",
            },
        },
    });

    function synclystPlayActiveVideo() {
        document.querySelectorAll('.works-ds .work-swiper video').forEach(function(v) { v.pause(); });
        var activeSlide = document.querySelector('.works-ds .work-swiper .swiper-slide-active');
        if (activeSlide) {
            var v = activeSlide.querySelector('video');
            if (v) {
                if (v.readyState < 1) { v.load(); v.addEventListener('canplay', function() { v.play().catch(function(){}); }, { once: true }); }
                else { v.play().catch(function(){}); }
            }
        }
    }
    workswip.on('slideChange', synclystPlayActiveVideo);
    workswip.on('transitionEnd', synclystPlayActiveVideo);
    setTimeout(synclystPlayActiveVideo, 100);
    setTimeout(synclystPlayActiveVideo, 500);

    function synclystSizeWorkVideos() {
        var cardWidth = Math.min(285, Math.floor($(window).width() * 0.82));
        if (workswip && workswip.update) workswip.update();
        $(".works-ds .work-swiper .swiper-slide").css("width", cardWidth + "px");
        $(".works-ds .synclyst-video-card").css("width", cardWidth + "px");
    }

    synclystSizeWorkVideos();
    setTimeout(synclystSizeWorkVideos, 300);
    $(window).on("resize", synclystSizeWorkVideos);

    $(".monthly_price").show();


    $('.accordion .accordion-item').on('click', function() {
        $(this).addClass("active").siblings().removeClass("active");
    });


});